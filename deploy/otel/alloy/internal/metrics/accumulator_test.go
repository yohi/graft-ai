package metrics

import (
	"math"
	"testing"
)

func TestAccumulator_keepsSumAndGaugeSeriesSeparate(t *testing.T) {
	accumulator := NewAccumulator()
	labels := map[string]string{"backend": "tempo"}
	if err := accumulator.Add(MetricSample{Name: "otel_backend_queue_utilization_ratio", Value: 1, Labels: labels}); err != nil {
		t.Fatalf("add sum: %v", err)
	}
	if err := accumulator.Add(MetricSample{Name: "otel_backend_queue_utilization_ratio", Value: 0.5, Labels: labels, Kind: Gauge}); err != nil {
		t.Fatalf("add gauge: %v", err)
	}

	normalized := accumulator.Flush(123)
	if len(normalized.Samples) != 2 {
		t.Fatalf("sample count = %d, want 2", len(normalized.Samples))
	}
	if normalized.Samples[0].Kind != Sum || normalized.Samples[1].Kind != Gauge {
		t.Fatalf("sample kinds = %v, %v; want sum, gauge", normalized.Samples[0].Kind, normalized.Samples[1].Kind)
	}
}

func TestAccumulator_rejectsNonFiniteGaugeBeforeRegisteringSeries(t *testing.T) {
	accumulator := NewAccumulator()
	if err := accumulator.Add(MetricSample{Name: "test_gauge", Value: math.NaN(), Kind: Gauge}); err == nil {
		t.Fatal("non-finite gauge was accepted")
	}

	if normalized := accumulator.Flush(123); len(normalized.Samples) != 0 {
		t.Fatalf("invalid gauge registered %d series, want 0", len(normalized.Samples))
	}
}

func TestAccumulator_rejectsGaugeBucketsBeforeRegisteringSeries(t *testing.T) {
	accumulator := NewAccumulator()
	if err := accumulator.Add(MetricSample{Name: "test_gauge", Value: 1, Kind: Gauge, Buckets: []float64{1}}); err == nil {
		t.Fatal("gauge with buckets was accepted")
	}

	if normalized := accumulator.Flush(123); len(normalized.Samples) != 0 {
		t.Fatalf("invalid gauge registered %d series, want 0", len(normalized.Samples))
	}
}
