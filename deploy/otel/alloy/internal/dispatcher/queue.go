package dispatcher

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"
)

type Backend string

const (
	Tempo      Backend = "tempo"
	Loki       Backend = "loki"
	Prometheus Backend = "prometheus"
)

type Output struct {
	Backend     Backend
	TraceID     string
	Payload     []byte
	ContentType string
	Priority    int
	Units       int
	ReceivedAt  time.Time
}

type BackendConfig struct {
	URL      string
	Headers  map[string]string
	MaxItems int
	MaxBytes int64
	Retry    RetryPolicy
}

type handoff struct {
	dropped bool
	reason  string
}

type backendQueue struct {
	mu     sync.Mutex
	items  []Output
	bytes  int64
	units  int
	closed bool
	signal chan struct{}
	config BackendConfig
	kind   Backend
}

func newBackendQueue(kind Backend, config BackendConfig) (*backendQueue, error) {
	if config.MaxItems <= 0 || config.MaxBytes <= 0 {
		return nil, errors.New("dispatcher: queue limits must be positive")
	}
	return &backendQueue{kind: kind, config: config, signal: make(chan struct{}, 1)}, nil
}

func (q *backendQueue) enqueue(output Output) handoff {
	size := int64(len(output.Payload))
	units := output.Units
	if units <= 0 {
		units = 1
	}
	output.Units = units
	if size > q.config.MaxBytes {
		return handoff{dropped: true, reason: "queue_capacity"}
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return handoff{dropped: true, reason: "shutdown_loss"}
	}
	for q.units+units > q.config.MaxItems || q.bytes+size > q.config.MaxBytes {
		if len(q.items) == 0 {
			return handoff{dropped: true, reason: "queue_capacity"}
		}
		index := q.evictionIndex()
		q.bytes -= int64(len(q.items[index].Payload))
		q.units -= q.items[index].Units
		q.items = append(q.items[:index], q.items[index+1:]...)
	}
	output.Payload = append([]byte(nil), output.Payload...)
	q.items = append(q.items, output)
	q.bytes += size
	q.units += units
	select {
	case q.signal <- struct{}{}:
	default:
	}
	return handoff{}
}

func (q *backendQueue) pop(ctx context.Context) (Output, bool) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			output := q.items[0]
			q.items = q.items[1:]
			q.bytes -= int64(len(output.Payload))
			q.units -= output.Units
			q.mu.Unlock()
			return output, true
		}
		if q.closed {
			q.mu.Unlock()
			return Output{}, false
		}
		signal := q.signal
		q.mu.Unlock()
		select {
		case <-signal:
		case <-ctx.Done():
			return Output{}, false
		}
	}
}

func (q *backendQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	select {
	case q.signal <- struct{}{}:
	default:
	}
}

func (q *backendQueue) evictionIndex() int {
	if q.kind == Loki {
		return lowestPriorityIndex(q.items)
	}
	return oldestIndex(q.items)
}

func oldestIndex(items []Output) int {
	return sortedIndex(items, func(left, right Output) bool {
		if left.ReceivedAt.Equal(right.ReceivedAt) {
			return left.TraceID < right.TraceID
		}
		return left.ReceivedAt.Before(right.ReceivedAt)
	})
}

func lowestPriorityIndex(items []Output) int {
	return sortedIndex(items, func(left, right Output) bool {
		if left.Priority != right.Priority {
			return left.Priority < right.Priority
		}
		if left.ReceivedAt.Equal(right.ReceivedAt) {
			return left.TraceID < right.TraceID
		}
		return left.ReceivedAt.Before(right.ReceivedAt)
	})
}

func sortedIndex(items []Output, less func(Output, Output) bool) int {
	indices := make([]int, len(items))
	for index := range indices {
		indices[index] = index
	}
	sort.SliceStable(indices, func(left, right int) bool {
		return less(items[indices[left]], items[indices[right]])
	})
	return indices[0]
}
