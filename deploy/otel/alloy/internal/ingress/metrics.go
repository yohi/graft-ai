package ingress

import (
	"maps"
	"sync"
)

type IngressMetrics struct {
	mu            sync.Mutex
	accepted      uint64
	rateLimited   uint64
	capacityDrops uint64
	rejections    map[string]uint64
}

type MetricsSnapshot struct {
	Accepted      uint64
	RateLimited   uint64
	CapacityDrops uint64
	Rejections    map[string]uint64
}

func NewIngressMetrics() *IngressMetrics {
	return &IngressMetrics{rejections: make(map[string]uint64)}
}

func (m *IngressMetrics) Accepted() {
	m.mu.Lock()
	m.accepted++
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
		RateLimited:   m.rateLimited,
		CapacityDrops: m.capacityDrops,
		Rejections:    rejections,
	}
}
