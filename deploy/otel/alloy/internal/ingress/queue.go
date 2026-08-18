package ingress

import (
	"context"
	"errors"
	"sync"
)

var ErrInvalidQueueCapacity = errors.New("otel ingress: invalid queue capacity")

type Envelope struct {
	TraceID     string
	Payload     []byte
	ContentType string
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
	if q.closed {
		return false
	}
	select {
	case q.items <- envelope:
		return true
	default:
		return false
	}
}

func (q *IngressQueue) Dequeue(ctx context.Context) (Envelope, bool) {
	select {
	case envelope, ok := <-q.items:
		return envelope, ok
	case <-ctx.Done():
		return Envelope{}, false
	}
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
