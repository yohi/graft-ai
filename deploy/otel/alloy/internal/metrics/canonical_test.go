package metrics

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

func TestCanonicalMetrics_normalizes_request_span_to_fixed_names_labels_and_buckets(t *testing.T) {
	span := redaction.RedactedSpan{Span: redaction.Span{
		Attributes: map[string]json.RawMessage{
			"graft_ai.request_span": raw(`true`),
			"model":                 raw(`"llama"`),
			"provider":              raw(`"cloudflare"`),
			"status_code":           raw(`500`),
			"env":                   raw(`"prod"`),
			"gateway":               raw(`"main"`),
			"duration_ms":           raw(`125.5`),
		},
	}}

	normalized := NewCanonicalMetrics().Normalize(span)
	if len(normalized.Samples) != 3 {
		t.Fatalf("samples = %d, want request/error/duration", len(normalized.Samples))
	}
	wantLabels := map[string]string{
		"model":       "llama",
		"provider":    "cloudflare",
		"status_code": "500",
		"env":         "prod",
		"gateway":     "main",
	}
	for _, sample := range normalized.Samples {
		if !reflect.DeepEqual(sample.Labels, wantLabels) {
			t.Fatalf("%s labels = %#v, want %#v", sample.Name, sample.Labels, wantLabels)
		}
	}
	if normalized.Samples[0].Name != "ai_gateway_requests_total" || normalized.Samples[1].Name != "ai_gateway_errors_total" || normalized.Samples[2].Name != "ai_gateway_request_duration_seconds" {
		t.Fatalf("sample names = %#v", normalized.Samples)
	}
	if normalized.Samples[1].Value != 1 || normalized.Samples[2].Value != 0.1255 {
		t.Fatalf("sample values = %#v", normalized.Samples)
	}
	wantBuckets := []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, math.Inf(1)}
	if !reflect.DeepEqual(normalized.Samples[2].Buckets, wantBuckets) {
		t.Fatalf("buckets = %#v, want %#v", normalized.Samples[2].Buckets, wantBuckets)
	}
}

func TestCanonicalMetrics_ignores_non_request_child_span(t *testing.T) {
	span := redaction.RedactedSpan{Span: redaction.Span{
		Attributes: map[string]json.RawMessage{
			"span.kind": raw(`"client"`),
			"model":     raw(`"llama"`),
		},
	}}
	if got := len(NewCanonicalMetrics().Normalize(span).Samples); got != 0 {
		t.Fatalf("child span contributed %d samples", got)
	}
}

func TestCanonicalMetrics_preserves_explicit_zero_duration_with_valid_timestamps(t *testing.T) {
	span := redaction.RedactedSpan{Span: redaction.Span{
		StartUnixNano: 1_000_000_000,
		EndUnixNano:   3_000_000_000,
		Attributes: map[string]json.RawMessage{
			"graft_ai.request_span": raw(`true`),
			"duration_ms":           raw(`0`),
		},
	}}

	normalized := NewCanonicalMetrics().Normalize(span)
	if len(normalized.Samples) != 2 {
		t.Fatalf("samples = %d, want request/duration", len(normalized.Samples))
	}
	if normalized.Samples[1].Name != DurationMetric || normalized.Samples[1].Value != 0 {
		t.Fatalf("duration sample = %#v, want zero duration", normalized.Samples[1])
	}
}

func TestCanonicalMetrics_uses_non_empty_string_fallback(t *testing.T) {
	span := redaction.RedactedSpan{Span: redaction.Span{
		Attributes: map[string]json.RawMessage{
			"graft_ai.request_span": raw(`true`),
			"model":                 raw(`""`),
			"gen_ai.request.model":  raw(`"fallback-model"`),
		},
	}}

	normalized := NewCanonicalMetrics().Normalize(span)
	if got := normalized.Samples[0].Labels["model"]; got != "fallback-model" {
		t.Fatalf("model label = %q, want fallback-model", got)
	}
}

func TestCanonicalMetrics_usesCloudflareProviderFallback(t *testing.T) {
	span := redaction.RedactedSpan{Span: redaction.Span{Attributes: map[string]json.RawMessage{
		"graft_ai.request_span": raw(`true`),
		"gen_ai.model.provider": raw(`"openai"`),
	}}}

	normalized := NewCanonicalMetrics().Normalize(span)
	if got := normalized.Samples[0].Labels["provider"]; got != "openai" {
		t.Fatalf("provider = %q, want openai", got)
	}
}

func raw(value string) json.RawMessage { return json.RawMessage(value) }
