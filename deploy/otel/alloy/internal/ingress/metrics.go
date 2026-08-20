package ingress

import (
	"maps"
	"sync"
)

type IngressMetrics struct {
	mu            sync.Mutex
	accepted      uint64
	requestBytes  uint64
	rateLimited   uint64
	capacityDrops uint64
	sizeDrops     uint64
	rejections    map[string]uint64
}

type MetricsSnapshot struct {
	Accepted      uint64
	RequestBytes  uint64
	RateLimited   uint64
	CapacityDrops uint64
	SizeDrops     uint64
	Rejections    map[string]uint64
}

func NewIngressMetrics() *IngressMetrics {
	return &IngressMetrics{rejections: make(map[string]uint64)}
}

func (m *IngressMetrics) Accepted() {
	m.AcceptedN(1)
}

func (m *IngressMetrics) AcceptedN(n int) {
	m.mu.Lock()
	m.accepted += uint64(n)
	m.mu.Unlock()
}

func (m *IngressMetrics) RequestBytes(n int) {
	if n <= 0 {
		return
	}
	m.mu.Lock()
	m.requestBytes += uint64(n)
	m.mu.Unlock()
}

func (m *IngressMetrics) RateLimited() {
	m.mu.Lock()
	m.rateLimited++
	m.mu.Unlock()
}

func (m *IngressMetrics) CapacityDrop() {
	m.mu.Lock()
	m.capacityDrops++
	m.mu.Unlock()
}

func (m *IngressMetrics) SizeDrop() {
	m.mu.Lock()
	m.sizeDrops++
	m.mu.Unlock()
}

func (m *IngressMetrics) Rejected(reason string) {
	m.mu.Lock()
	m.rejections[reason]++
	m.mu.Unlock()
}

func (m *IngressMetrics) Snapshot() MetricsSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	rejections := make(map[string]uint64, len(m.rejections))
	maps.Copy(rejections, m.rejections)
	return MetricsSnapshot{
		Accepted:      m.accepted,
		RequestBytes:  m.requestBytes,
		RateLimited:   m.rateLimited,
		CapacityDrops: m.capacityDrops,
		SizeDrops:     m.sizeDrops,
		Rejections:    rejections,
	}
}
