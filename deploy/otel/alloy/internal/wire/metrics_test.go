package wire

import (
	"encoding/json"
	"testing"

	collectormetricspb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/metrics"
)

func TestEncodeMetrics_histogram_bucket_counts_are_non_cumulative(t *testing.T) {
	normalized := metrics.NormalizedMetrics{Samples: []metrics.MetricSample{{
		Name:         "ai_gateway_request_duration_seconds",
		Value:        0.15,
		Labels:       map[string]string{"model": "m", "status_code": "200"},
		Buckets:      []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 1e308},
		BucketCounts: []uint64{0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0},
		Count:        1,
	}}}

	payload, err := EncodeMetrics(normalized, 1_000_000_000_000, 1_000_003_000_000)
	if err != nil {
		t.Fatalf("EncodeMetrics: %v", err)
	}

	var request collectormetricspb.ExportMetricsServiceRequest
	if err := proto.Unmarshal(payload, &request); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	point := request.ResourceMetrics[0].ScopeMetrics[0].Metrics[0].GetHistogram().DataPoints[0]
	if point.Count != 1 {
		t.Fatalf("Count = %d, want 1", point.Count)
	}
	if point.StartTimeUnixNano != 1_000_000_000_000 {
		t.Fatalf("StartTimeUnixNano = %d, want 1_000_000_000_000", point.StartTimeUnixNano)
	}
	if point.TimeUnixNano != 1_000_003_000_000 {
		t.Fatalf("TimeUnixNano = %d, want 1_000_003_000_000", point.TimeUnixNano)
	}

	var populated int
	for _, count := range point.BucketCounts {
		if count != 0 {
			populated++
		}
	}
	if populated != 1 {
		t.Fatalf("non-zero bucket count = %d, want 1; got %v", populated, point.BucketCounts)
	}
}

func TestEncodeMetrics_histogram_bucket_counts_sum_equals_count(t *testing.T) {
	normalized := metrics.NormalizedMetrics{Samples: []metrics.MetricSample{{
		Name:         "ai_gateway_request_duration_seconds",
		Value:        2.0,
		Labels:       map[string]string{"model": "m", "status_code": "200"},
		Buckets:      []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 1e308},
		BucketCounts: []uint64{0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0},
		Count:        1,
	}}}

	payload, err := EncodeMetrics(normalized, 1_000_000_000_000, 1_000_003_000_000)
	if err != nil {
		t.Fatalf("EncodeMetrics: %v", err)
	}

	var request collectormetricspb.ExportMetricsServiceRequest
	if err := proto.Unmarshal(payload, &request); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	point := request.ResourceMetrics[0].ScopeMetrics[0].Metrics[0].GetHistogram().DataPoints[0]
	var sum uint64
	for _, count := range point.BucketCounts {
		sum += count
	}
	if sum != point.Count {
		t.Fatalf("sum(bucket_counts) = %d, Count = %d", sum, point.Count)
	}
}

func TestEncodeMetrics_non_request_sample_is_sum_not_histogram(t *testing.T) {
	normalized := metrics.NormalizedMetrics{Samples: []metrics.MetricSample{{
		Name:   "ai_gateway_requests_total",
		Value:  1,
		Labels: map[string]string{"model": "m"},
	}}}

	payload, err := EncodeMetrics(normalized, 1_000_000_000_000, 1_000_003_000_000)
	if err != nil {
		t.Fatalf("EncodeMetrics: %v", err)
	}

	var request collectormetricspb.ExportMetricsServiceRequest
	if err := proto.Unmarshal(payload, &request); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	metric := request.ResourceMetrics[0].ScopeMetrics[0].Metrics[0]
	if metric.GetSum() == nil {
		t.Fatalf("expected Sum metric, got %T", metric.Data)
	}
	point := metric.GetSum().DataPoints[0]
	if point.StartTimeUnixNano != 1_000_000_000_000 {
		t.Fatalf("StartTimeUnixNano = %d, want 1_000_000_000_000", point.StartTimeUnixNano)
	}
	if point.TimeUnixNano != 1_000_003_000_000 {
		t.Fatalf("TimeUnixNano = %d, want 1_000_003_000_000", point.TimeUnixNano)
	}
}

func TestEncodeMetrics_aggregateSamples_no_double_counting(t *testing.T) {
	normalized := metrics.NormalizedMetrics{Samples: []metrics.MetricSample{
		{Name: "ai_gateway_requests_total", Value: 1, Labels: map[string]string{"model": "m"}},
		{Name: "ai_gateway_requests_total", Value: 1, Labels: map[string]string{"model": "m"}},
		{Name: "ai_gateway_errors_total", Value: 1, Labels: map[string]string{"model": "m"}},
	}}

	payload, err := EncodeMetrics(normalized, 1_000_000_000_000, 1_000_003_000_000)
	if err != nil {
		t.Fatalf("EncodeMetrics: %v", err)
	}

	var request collectormetricspb.ExportMetricsServiceRequest
	if err := proto.Unmarshal(payload, &request); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	metrics := request.ResourceMetrics[0].ScopeMetrics[0].Metrics
	for _, metric := range metrics {
		name := metric.GetName()
		value := metric.GetSum().DataPoints[0].GetAsDouble()
		switch name {
		case "ai_gateway_requests_total":
			if value != 2 {
				t.Fatalf("requests_total = %v, want 2", value)
			}
		case "ai_gateway_errors_total":
			if value != 1 {
				t.Fatalf("errors_total = %v, want 1", value)
			}
		}
	}
}

func raw(value string) json.RawMessage { return json.RawMessage(value) }
