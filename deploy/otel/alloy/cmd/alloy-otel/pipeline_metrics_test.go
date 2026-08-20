package main

import (
	"testing"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/dispatcher"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/ingress"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/metrics"
)

func TestAddDispatcherMetrics_emitsCounterDeltasAndQueueGauges(t *testing.T) {
	accumulator := metrics.NewAccumulator()
	previous := dispatcher.MetricsSnapshot{
		Retries:              map[dispatcher.Backend]uint64{dispatcher.Tempo: 2},
		Failures:             map[dispatcher.Backend]uint64{dispatcher.Tempo: 1},
		FailureStatusClasses: map[dispatcher.Backend]map[string]uint64{dispatcher.Tempo: {"5xx": 1}},
		Exhausted:            map[dispatcher.Backend]uint64{dispatcher.Tempo: 1},
		Drops:                map[dispatcher.Backend]uint64{dispatcher.Tempo: 3},
	}
	current := dispatcher.MetricsSnapshot{
		Retries:               map[dispatcher.Backend]uint64{dispatcher.Tempo: 5},
		Failures:              map[dispatcher.Backend]uint64{dispatcher.Tempo: 3},
		FailureStatusClasses:  map[dispatcher.Backend]map[string]uint64{dispatcher.Tempo: {"5xx": 3}},
		Exhausted:             map[dispatcher.Backend]uint64{dispatcher.Tempo: 2},
		Drops:                 map[dispatcher.Backend]uint64{dispatcher.Tempo: 4},
		QueueUtilization:      map[dispatcher.Backend]float64{dispatcher.Tempo: 0.75},
		QueueOldestAgeSeconds: map[dispatcher.Backend]float64{dispatcher.Tempo: 4},
	}

	addDispatcherMetrics(accumulator, current, previous)
	samples := accumulator.Flush(123).Samples
	assertMetricValue(t, samples, "otel_backend_export_retries_total", 3, metrics.Sum, map[string]string{"backend": "tempo"})
	assertMetricValue(t, samples, "otel_backend_export_failures_total", 2, metrics.Sum, map[string]string{"backend": "tempo", "status_class": "5xx"})
	assertMetricValue(t, samples, "otel_backend_export_exhausted_total", 1, metrics.Sum, map[string]string{"backend": "tempo"})
	assertMetricValue(t, samples, "otel_backend_queue_dropped_total", 1, metrics.Sum, map[string]string{"backend": "tempo", "signal": "export", "reason": "total"})
	assertMetricValue(t, samples, "otel_backend_queue_utilization_ratio", 0.75, metrics.Gauge, map[string]string{"backend": "tempo"})
	assertMetricValue(t, samples, "otel_backend_queue_oldest_age_seconds", 4, metrics.Gauge, map[string]string{"backend": "tempo"})
}

func TestAddIngressMetrics_emitsCounterDeltas(t *testing.T) {
	accumulator := metrics.NewAccumulator()
	previous := ingress.MetricsSnapshot{Accepted: 4, RateLimited: 1, CapacityDrops: 2, SizeDrops: 1, Rejections: map[string]uint64{"auth": 3}}
	current := ingress.MetricsSnapshot{Accepted: 7, RateLimited: 3, CapacityDrops: 4, SizeDrops: 2, Rejections: map[string]uint64{"auth": 4, "parse": 2}}

	addIngressMetrics(accumulator, current, previous)
	samples := accumulator.Flush(123).Samples
	assertMetricValue(t, samples, "otel_ingress_requests_total", 3, metrics.Sum, map[string]string{"status": "accepted"})
	assertMetricValue(t, samples, "otel_ingress_rate_limited_total", 2, metrics.Sum, nil)
	assertMetricValue(t, samples, "otel_ingress_queue_dropped_total", 2, metrics.Sum, map[string]string{"reason": "capacity"})
	assertMetricValue(t, samples, "otel_ingress_rejections_total", 1, metrics.Sum, map[string]string{"reason": "auth"})
	assertMetricValue(t, samples, "otel_ingress_rejections_total", 2, metrics.Sum, map[string]string{"reason": "parse"})
}

func assertMetricValue(t *testing.T, samples []metrics.MetricSample, name string, want float64, kind metrics.MetricKind, labels map[string]string) {
	t.Helper()
	for _, sample := range samples {
		if sample.Name == name && sample.Kind == kind && equalLabels(sample.Labels, labels) {
			if sample.Value != want {
				t.Fatalf("%s value = %v, want %v", name, sample.Value, want)
			}
			return
		}
	}
	t.Fatalf("missing metric %s kind=%v labels=%v in %#v", name, kind, labels, samples)
}

func equalLabels(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range right {
		if left[key] != value {
			return false
		}
	}
	return true
}
