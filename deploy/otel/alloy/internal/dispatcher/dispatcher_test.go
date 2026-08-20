package dispatcher

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDispatcher_handoff_sends_each_backend_independently(t *testing.T) {
	received := make(chan struct {
		backend Backend
		body    []byte
	}, 3)
	servers := make(map[Backend]*httptest.Server)
	for _, backend := range []Backend{Tempo, Loki, Prometheus} {
		servers[backend] = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Errorf("read request body: %v", err)
			}
			received <- struct {
				backend Backend
				body    []byte
			}{backend: backend, body: body}
			writer.WriteHeader(http.StatusOK)
		}))
		defer servers[backend].Close()
	}

	dispatcher, err := NewDispatcher(DispatcherConfig{
		Client: &http.Client{Timeout: time.Second},
		Backends: map[Backend]BackendConfig{
			Tempo:      {URL: servers[Tempo].URL, MaxItems: 2, MaxBytes: 1024},
			Loki:       {URL: servers[Loki].URL, MaxItems: 2, MaxBytes: 1024},
			Prometheus: {URL: servers[Prometheus].URL, MaxItems: 2, MaxBytes: 1024},
		},
	})
	if err != nil {
		t.Fatalf("new dispatcher: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	dispatcher.Start(ctx)
	defer func() {
		dispatcher.Close()
		cancel()
	}()

	for _, output := range []Output{
		{Backend: Tempo, TraceID: "trace", Payload: []byte("tempo"), ContentType: "application/x-protobuf"},
		{Backend: Loki, TraceID: "trace", Payload: []byte("loki"), ContentType: "application/json"},
		{Backend: Prometheus, TraceID: "trace", Payload: []byte("metrics"), ContentType: "application/x-protobuf"},
	} {
		if result := dispatcher.Handoff(output); result.Dropped {
			t.Fatalf("handoff dropped %s: %s", output.Backend, result.Reason)
		}
	}

	receivedBodies := make(map[Backend][]byte, 3)
	for range 3 {
		select {
		case item := <-received:
			receivedBodies[item.backend] = item.body
		case <-time.After(time.Second):
			t.Fatal("backend output was not delivered")
		}
	}
	if string(receivedBodies[Tempo]) != "tempo" || string(receivedBodies[Loki]) != "loki" || string(receivedBodies[Prometheus]) != "metrics" {
		t.Fatalf("received = %#v", receivedBodies)
	}
}

func TestRetryPolicy_retries_transient_statuses_only(t *testing.T) {
	policy := DefaultRetryPolicy()
	for _, status := range []int{http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError} {
		if !policy.Retryable(&HTTPError{Status: status}) {
			t.Fatalf("status %d was not retryable", status)
		}
	}
	if policy.Retryable(&HTTPError{Status: http.StatusBadRequest}) {
		t.Fatal("status 400 was retryable")
	}
}

func TestDispatcher_records_evicted_items_as_queue_drops(t *testing.T) {
	dispatcher, err := NewDispatcher(DispatcherConfig{Backends: map[Backend]BackendConfig{
		Tempo: {URL: "http://tempo.invalid", MaxItems: 1, MaxBytes: 1024},
	}})
	if err != nil {
		t.Fatalf("new dispatcher: %v", err)
	}
	first := Output{Backend: Tempo, TraceID: "first", Payload: []byte("first"), ReceivedAt: time.Unix(1, 0)}
	second := Output{Backend: Tempo, TraceID: "second", Payload: []byte("second"), ReceivedAt: time.Unix(2, 0)}
	if result := dispatcher.Handoff(first); result.Dropped {
		t.Fatalf("first handoff dropped: %s", result.Reason)
	}
	result := dispatcher.Handoff(second)
	if result.Dropped || result.Evicted != 1 {
		t.Fatalf("second handoff = %#v, want accepted with one eviction", result)
	}
	snapshot := dispatcher.SnapshotAt(time.Unix(3, 0))
	if snapshot.Drops[Tempo] != 1 || snapshot.DropReasons[Tempo]["queue_capacity"] != 1 {
		t.Fatalf("drop metrics = %#v, want one queue_capacity drop", snapshot)
	}
	if snapshot.QueueUtilization[Tempo] != 1 {
		t.Fatalf("queue utilization = %#v, want full queue", snapshot.QueueUtilization)
	}
	if snapshot.QueueOldestAgeSeconds[Tempo] != 1 {
		t.Fatalf("queue oldest age = %#v, want one second", snapshot.QueueOldestAgeSeconds)
	}
}
