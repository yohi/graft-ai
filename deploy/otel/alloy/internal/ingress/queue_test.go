package ingress

import (
	"context"
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
