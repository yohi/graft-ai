package dispatcher

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"sync"
	"time"
)

type DispatcherConfig struct {
	Client   *http.Client
	Backends map[Backend]BackendConfig
}

type HandoffResult struct {
	Dropped bool
	Reason  string
	Evicted int
}

type MetricsSnapshot struct {
	Retries               map[Backend]uint64
	Failures              map[Backend]uint64
	FailureStatusClasses  map[Backend]map[string]uint64
	Exhausted             map[Backend]uint64
	Drops                 map[Backend]uint64
	DropReasons           map[Backend]map[string]uint64
	QueueUtilization      map[Backend]float64
	QueueOldestAgeSeconds map[Backend]float64
}

type Dispatcher struct {
	client  *http.Client
	queues  map[Backend]*backendQueue
	metrics dispatcherMetrics
	workers sync.WaitGroup
}

// HasBackend reports whether a backend is enabled for delivery.
func (d *Dispatcher) HasBackend(backend Backend) bool {
	_, ok := d.queues[backend]
	return ok
}

type dispatcherMetrics struct {
	mu                   sync.Mutex
	retries              map[Backend]uint64
	failures             map[Backend]uint64
	failureStatusClasses map[Backend]map[string]uint64
	exhausted            map[Backend]uint64
	drops                map[Backend]uint64
	dropReasons          map[Backend]map[string]uint64
}

func NewDispatcher(config DispatcherConfig) (*Dispatcher, error) {
	if len(config.Backends) == 0 {
		return nil, errors.New("dispatcher: no backends configured")
	}
	client := config.Client
	if client == nil {
		client = &http.Client{}
	}
	dispatcher := &Dispatcher{
		client: client,
		queues: make(map[Backend]*backendQueue, len(config.Backends)),
		metrics: dispatcherMetrics{
			retries:              make(map[Backend]uint64),
			failures:             make(map[Backend]uint64),
			failureStatusClasses: make(map[Backend]map[string]uint64),
			exhausted:            make(map[Backend]uint64),
			drops:                make(map[Backend]uint64),
			dropReasons:          make(map[Backend]map[string]uint64),
		},
	}
	for backend, backendConfig := range config.Backends {
		if backendConfig.URL == "" {
			return nil, fmt.Errorf("dispatcher: %s URL is empty", backend)
		}
		if backendConfig.Retry.Attempts == 0 {
			backendConfig.Retry = DefaultRetryPolicy()
		}
		queue, err := newBackendQueue(backend, backendConfig)
		if err != nil {
			return nil, fmt.Errorf("configure %s queue: %w", backend, err)
		}
		dispatcher.queues[backend] = queue
	}
	return dispatcher, nil
}

func (d *Dispatcher) Start(ctx context.Context) {
	for backend, queue := range d.queues {
		d.workers.Add(1)
		go d.worker(ctx, backend, queue)
	}
}

func (d *Dispatcher) Handoff(output Output) HandoffResult {
	queue, ok := d.queues[output.Backend]
	if !ok {
		d.recordDrop(output.Backend, "backend_unconfigured", 1)
		return HandoffResult{Dropped: true, Reason: "backend_unconfigured"}
	}
	result := queue.enqueue(output)
	if result.evicted > 0 {
		d.recordDrop(output.Backend, "queue_capacity", uint64(result.evicted))
	}
	if result.dropped {
		d.recordDrop(output.Backend, result.reason, 1)
	}
	return HandoffResult{Dropped: result.dropped, Reason: result.reason, Evicted: result.evicted}
}

func (d *Dispatcher) Close() {
	for _, queue := range d.queues {
		queue.close()
	}
	d.workers.Wait()
}

func (d *Dispatcher) Snapshot() MetricsSnapshot {
	return d.SnapshotAt(time.Now())
}

func (d *Dispatcher) SnapshotAt(now time.Time) MetricsSnapshot {
	d.metrics.mu.Lock()
	snapshot := MetricsSnapshot{
		Retries:               copyCounts(d.metrics.retries),
		Failures:              copyCounts(d.metrics.failures),
		FailureStatusClasses:  copyStatusClasses(d.metrics.failureStatusClasses),
		Exhausted:             copyCounts(d.metrics.exhausted),
		Drops:                 copyCounts(d.metrics.drops),
		DropReasons:           copyDropReasons(d.metrics.dropReasons),
		QueueUtilization:      make(map[Backend]float64, len(d.queues)),
		QueueOldestAgeSeconds: make(map[Backend]float64, len(d.queues)),
	}
	d.metrics.mu.Unlock()
	for backend, queue := range d.queues {
		queueSnapshot := queue.snapshotAt(now)
		snapshot.QueueUtilization[backend] = queueSnapshot.utilization
		snapshot.QueueOldestAgeSeconds[backend] = queueSnapshot.oldestAge
	}
	return snapshot
}

func (d *Dispatcher) worker(ctx context.Context, backend Backend, queue *backendQueue) {
	defer d.workers.Done()
	for {
		output, ok := queue.pop(ctx)
		if !ok {
			return
		}
		if err := d.sendWithRetry(ctx, backend, queue.config, output); err != nil {
			d.recordExhausted(backend)
		}
	}
}

func (d *Dispatcher) sendWithRetry(ctx context.Context, backend Backend, config BackendConfig, output Output) error {
	attempts := config.Retry.Attempts
	if attempts <= 0 {
		attempts = 1
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		lastErr = d.send(ctx, backend, config, output)
		if lastErr == nil {
			return nil
		}
		d.recordFailure(backend, failureStatusClass(lastErr))
		if attempt == attempts-1 || !config.Retry.Retryable(lastErr) {
			return lastErr
		}
		d.recordRetry(backend)
		if err := config.Retry.wait(ctx, attempt); err != nil {
			return fmt.Errorf("wait before %s retry: %w", backend, err)
		}
	}
	return lastErr
}

const maxDrainBytes = 64 * 1024

func (d *Dispatcher) send(ctx context.Context, backend Backend, config BackendConfig, output Output) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.URL, bytes.NewReader(output.Payload))
	if err != nil {
		return fmt.Errorf("build %s request: %w", backend, err)
	}
	request.Header.Set("Content-Type", output.ContentType)
	for key, value := range config.Headers {
		request.Header.Set(key, value)
	}
	response, err := d.client.Do(request)
	if err != nil {
		return fmt.Errorf("send %s output: %w", backend, err)
	}
	defer response.Body.Close()
	if _, err := io.Copy(io.Discard, io.LimitReader(response.Body, maxDrainBytes)); err != nil {
		return fmt.Errorf("read %s response: %w", backend, err)
	}
	if response.StatusCode >= http.StatusBadRequest {
		return &HTTPError{Status: response.StatusCode}
	}
	return nil
}

func (d *Dispatcher) recordRetry(backend Backend) {
	d.metrics.mu.Lock()
	d.metrics.retries[backend]++
	d.metrics.mu.Unlock()
}

func (d *Dispatcher) recordFailure(backend Backend, statusClass string) {
	d.metrics.mu.Lock()
	d.metrics.failures[backend]++
	if d.metrics.failureStatusClasses[backend] == nil {
		d.metrics.failureStatusClasses[backend] = make(map[string]uint64)
	}
	d.metrics.failureStatusClasses[backend][statusClass]++
	d.metrics.mu.Unlock()
}

func (d *Dispatcher) recordExhausted(backend Backend) {
	d.metrics.mu.Lock()
	d.metrics.exhausted[backend]++
	d.metrics.mu.Unlock()
}

func (d *Dispatcher) recordDrop(backend Backend, reason string, count uint64) {
	d.metrics.mu.Lock()
	d.metrics.drops[backend] += count
	if reason != "" {
		if d.metrics.dropReasons[backend] == nil {
			d.metrics.dropReasons[backend] = make(map[string]uint64)
		}
		d.metrics.dropReasons[backend][reason] += count
	}
	d.metrics.mu.Unlock()
}

func copyCounts(source map[Backend]uint64) map[Backend]uint64 {
	copy := make(map[Backend]uint64, len(source))
	maps.Copy(copy, source)
	return copy
}

func copyDropReasons(source map[Backend]map[string]uint64) map[Backend]map[string]uint64 {
	copy := make(map[Backend]map[string]uint64, len(source))
	for backend, reasons := range source {
		copy[backend] = make(map[string]uint64, len(reasons))
		maps.Copy(copy[backend], reasons)
	}
	return copy
}

func copyStatusClasses(source map[Backend]map[string]uint64) map[Backend]map[string]uint64 {
	copy := make(map[Backend]map[string]uint64, len(source))
	for backend, classes := range source {
		copy[backend] = make(map[string]uint64, len(classes))
		maps.Copy(copy[backend], classes)
	}
	return copy
}

func failureStatusClass(err error) string {
	var httpError *HTTPError
	if !errors.As(err, &httpError) {
		return "network"
	}
	return fmt.Sprintf("%dxx", httpError.Status/100)
}
