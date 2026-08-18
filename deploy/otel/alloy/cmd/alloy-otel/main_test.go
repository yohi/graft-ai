package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/ingress"
)

func TestForwardEnvelope_delivers_envelope_to_downstream(t *testing.T) {
	var receivedBody []byte
	var receivedContentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %q, want POST", r.Method)
		}
		receivedBody, _ = io.ReadAll(r.Body)
		receivedContentType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	envelope := ingress.Envelope{
		TraceID:     "00112233445566778899aabbccddeeff",
		Payload:     []byte("otlp-payload"),
		ContentType: "application/x-protobuf",
	}
	client := &http.Client{Timeout: time.Second}
	if err := forwardEnvelope(context.Background(), client, server.URL, envelope); err != nil {
		t.Fatalf("forward envelope: %v", err)
	}
	if string(receivedBody) != string(envelope.Payload) {
		t.Fatalf("body = %q, want %q", receivedBody, envelope.Payload)
	}
	if receivedContentType != envelope.ContentType {
		t.Fatalf("Content-Type = %q, want %q", receivedContentType, envelope.ContentType)
	}
}

func TestForwardEnvelope_returns_error_on_downstream_failure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("bad request"))
	}))
	defer server.Close()

	envelope := ingress.Envelope{Payload: []byte("payload"), ContentType: "application/x-protobuf"}
	client := &http.Client{Timeout: time.Second}
	err := forwardEnvelope(context.Background(), client, server.URL, envelope)
	if err == nil {
		t.Fatal("expected error for downstream 400, got nil")
	}
}

func TestForwardLoop_drains_queue_before_context_cancel(t *testing.T) {
	var forwarded atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	queue, err := ingress.NewIngressQueue(10)
	if err != nil {
		t.Fatalf("new queue: %v", err)
	}
	for i := range 3 {
		if !queue.Enqueue(ingress.Envelope{TraceID: string(rune('a' + i)), Payload: []byte("x"), ContentType: "application/x-protobuf"}) {
			t.Fatal("enqueue failed")
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	client := &http.Client{Timeout: time.Second}
	done := make(chan struct{})
	go func() {
		forwardLoop(ctx, client, server.URL, queue)
		close(done)
	}()

	queue.Close()
	<-done
	cancel()

	if got := forwarded.Load(); got != 3 {
		t.Fatalf("forwarded = %d, want 3", got)
	}
}

func TestLoadConfig_parses_sampling_rate_as_integer_ppm(t *testing.T) {
	t.Setenv("OTEL_INGEST_TOKEN", "ingest-token")
	t.Setenv("OTEL_TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	t.Setenv("OTEL_RATE_LIMIT_HMAC_KEY", "hmac-key")
	t.Setenv("OTEL_SAMPLING_RATE", "0.5")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.samplingRatePPM != 500_000 {
		t.Fatalf("sampling rate ppm = %d, want 500000", cfg.samplingRatePPM)
	}

	t.Setenv("OTEL_SAMPLING_RATE", "1.000001")
	if _, err := loadConfig(); err == nil {
		t.Fatal("invalid sampling rate was accepted")
	}
}
