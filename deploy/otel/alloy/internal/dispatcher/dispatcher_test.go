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
