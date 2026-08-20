package main

import (
	"testing"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/metrics"
)

func TestMetricsFlushPolicy_triggers_at_two_hundred_data_points_or_one_second(t *testing.T) {
	accumulator := metrics.NewAccumulator()
	for range maxMetricsDataPoints - 1 {
		if err := accumulator.Add(metrics.MetricSample{Name: "test_metric", Value: 1}); err != nil {
			t.Fatalf("add metric sample: %v", err)
		}
	}
	if shouldFlushMetrics(accumulator) {
		t.Fatal("flush triggered before reaching the data-point limit")
	}
	if err := accumulator.Add(metrics.MetricSample{Name: "test_metric", Value: 1}); err != nil {
		t.Fatalf("add final metric sample: %v", err)
	}
	if !shouldFlushMetrics(accumulator) {
		t.Fatal("flush did not trigger at the data-point limit")
	}
	if metricsFlushInterval != time.Second {
		t.Fatalf("metrics flush interval = %s, want 1s", metricsFlushInterval)
	}
}
