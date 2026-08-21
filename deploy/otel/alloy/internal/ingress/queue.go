package ingress

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

var ErrInvalidQueueCapacity = errors.New("otel ingress: invalid queue capacity")

type Envelope struct {
	SamplingRatePPM uint32
	ReceivedAt      time.Time
	Spans           []redaction.RedactedSpan
}

type IngressQueue struct {
	mu     sync.Mutex
	items  chan Envelope
	closed bool
}

func NewIngressQueue(capacity int) (*IngressQueue, error) {
	if capacity <= 0 {
		return nil, ErrInvalidQueueCapacity
	}
	return &IngressQueue{items: make(chan Envelope, capacity)}, nil
}

func (q *IngressQueue) Enqueue(envelope Envelope) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed || len(q.items) == cap(q.items) {
		return false
	}
	q.items <- cloneEnvelope(envelope)
	return true
}

func cloneEnvelope(envelope Envelope) Envelope {
	cloned := Envelope{
		SamplingRatePPM: envelope.SamplingRatePPM,
		ReceivedAt:      envelope.ReceivedAt,
		Spans:           make([]redaction.RedactedSpan, len(envelope.Spans)),
	}
	for index, span := range envelope.Spans {
		cloned.Spans[index] = cloneRedactedSpan(span)
	}
	return cloned
}

func cloneRedactedSpan(span redaction.RedactedSpan) redaction.RedactedSpan {
	span.Attributes = cloneRawAttributes(span.Attributes)
	span.ResourceAttributes = cloneRawAttributes(span.ResourceAttributes)
	return span
}

func cloneRawAttributes(attributes map[string]json.RawMessage) map[string]json.RawMessage {
	cloned := make(map[string]json.RawMessage, len(attributes))
	for key, value := range attributes {
		cloned[key] = append(json.RawMessage(nil), value...)
	}
	return cloned
}

func (q *IngressQueue) Dequeue(ctx context.Context) (Envelope, bool) {
	select {
	case envelope, ok := <-q.items:
		return envelope, ok
	case <-ctx.Done():
		return Envelope{}, false
	}
}

func (q *IngressQueue) Items() <-chan Envelope {
	return q.items
}

func (q *IngressQueue) Len() int {
	return len(q.items)
}

func (q *IngressQueue) Capacity() int {
	return cap(q.items)
}

func (q *IngressQueue) Close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.closed = true
	close(q.items)
}
