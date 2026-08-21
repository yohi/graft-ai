package ingress

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

func TestIngressQueue_drops_new_item_when_capacity_is_full(t *testing.T) {
	queue, err := NewIngressQueue(1)
	if err != nil {
		t.Fatalf("new queue: %v", err)
	}

	if !queue.Enqueue(Envelope{Spans: []redaction.RedactedSpan{{Span: redaction.Span{TraceID: "first"}}}}) {
		t.Fatalf("first enqueue was rejected")
	}
	if queue.Enqueue(Envelope{Spans: []redaction.RedactedSpan{{Span: redaction.Span{TraceID: "second"}}}}) {
		t.Fatalf("second enqueue was accepted despite full capacity")
	}

	got, ok := queue.Dequeue(context.Background())
	if !ok || len(got.Spans) != 1 || got.Spans[0].TraceID != "first" {
		t.Fatalf("dequeued envelope = %#v, ok = %v", got, ok)
	}
}

func TestIngressQueue_dequeue_observes_close_without_blocking(t *testing.T) {
	queue, err := NewIngressQueue(1)
	if err != nil {
		t.Fatalf("new queue: %v", err)
	}
	queue.Close()

	if _, ok := queue.Dequeue(context.Background()); ok {
		t.Fatalf("dequeue succeeded after queue close")
	}
	if queue.Enqueue(Envelope{Spans: []redaction.RedactedSpan{{Span: redaction.Span{TraceID: "after-close"}}}}) {
		t.Fatalf("enqueue succeeded after queue close")
	}
}

func TestIngressQueue_doesNotCloneRejectedEnvelope(t *testing.T) {
	envelope := Envelope{Spans: []redaction.RedactedSpan{{Span: redaction.Span{
		Attributes: map[string]json.RawMessage{
			"payload": bytes.Repeat([]byte("x"), 1024),
		},
	}}}}

	t.Run("full", func(t *testing.T) {
		queue, err := NewIngressQueue(1)
		if err != nil {
			t.Fatalf("new queue: %v", err)
		}
		if !queue.Enqueue(Envelope{}) {
			t.Fatal("failed to fill queue")
		}
		if queue.Enqueue(envelope) {
			t.Fatal("full queue accepted envelope")
		}

		if allocations := testing.AllocsPerRun(100, func() {
			queue.Enqueue(envelope)
		}); allocations != 0 {
			t.Fatalf("rejected full enqueue allocations = %v, want 0", allocations)
		}
	})

	t.Run("closed", func(t *testing.T) {
		queue, err := NewIngressQueue(1)
		if err != nil {
			t.Fatalf("new queue: %v", err)
		}
		queue.Close()
		if queue.Enqueue(envelope) {
			t.Fatal("closed queue accepted envelope")
		}

		if allocations := testing.AllocsPerRun(100, func() {
			queue.Enqueue(envelope)
		}); allocations != 0 {
			t.Fatalf("rejected closed enqueue allocations = %v, want 0", allocations)
		}
	})
}
