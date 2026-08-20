package fanout

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/sampling"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/selector"
)

func TestFanOut_sends_metrics_before_sampling_and_keeps_branch_local_copies(t *testing.T) {
	trace := selector.Trace{
		TraceID: "00000000000000000000000000000001",
		Spans: []redaction.RedactedSpan{
			requestSpan("root", true),
			requestSpan("child", false),
		},
		RequestSpan:    requestSpan("root", true),
		HasRequestSpan: true,
	}
	sampler, err := sampling.NewSampler("graft-ai-otel-v1")
	if err != nil {
		t.Fatalf("new sampler: %v", err)
	}
	result, err := NewFanOut(sampler).Trace(trace, 1_000_000)
	if err != nil {
		t.Fatalf("fanout trace: %v", err)
	}
	if !result.Sampled || len(result.Tempo) != 2 || len(result.Loki) != 1 {
		t.Fatalf("result = %#v, want sampled Tempo trace and one Loki record", result)
	}
	if len(result.Metrics.Samples) != 2 {
		t.Fatalf("metrics samples = %d, want 2 for request and duration", len(result.Metrics.Samples))
	}
	for _, span := range result.Tempo {
		if _, ok := span.Attributes[redaction.PromptAttribute]; ok {
			t.Fatalf("Tempo branch retained prompt payload")
		}
		if _, ok := span.Attributes["graft_ai.request_span"]; !ok {
			t.Fatal("Tempo branch dropped graft_ai.request_span marker")
		}
	}
	if _, ok := result.Loki[0].Fields["prompt"]; !ok {
		t.Fatalf("Loki branch lost redacted prompt")
	}
	result.Tempo[0].Attributes["model"] = json.RawMessage(`"mutated"`)
	if strings.Contains(string(trace.Spans[0].Attributes["model"]), "mutated") {
		t.Fatalf("Tempo branch mutation changed input trace")
	}
}

func TestFanOut_excludes_sampled_out_trace_from_tempo_and_loki_but_keeps_metrics(t *testing.T) {
	trace := selector.Trace{
		TraceID:        "00000000000000000000000000000001",
		Spans:          []redaction.RedactedSpan{requestSpan("root", true)},
		RequestSpan:    requestSpan("root", true),
		HasRequestSpan: true,
	}
	sampler, err := sampling.NewSampler("graft-ai-otel-v1")
	if err != nil {
		t.Fatalf("new sampler: %v", err)
	}
	result, err := NewFanOut(sampler).Trace(trace, 0)
	if err != nil {
		t.Fatalf("fanout trace: %v", err)
	}
	if result.Sampled || len(result.Tempo) != 0 || len(result.Loki) != 0 {
		t.Fatalf("sampled-out result = %#v", result)
	}
	if len(result.Metrics.Samples) != 2 {
		t.Fatalf("metrics samples = %d, want 2 before sampling", len(result.Metrics.Samples))
	}
}

func TestFanOut_keeps_metrics_and_tempo_when_payload_field_is_invalid(t *testing.T) {
	span := requestSpan("root", true)
	span.Attributes["duration_ms"] = json.RawMessage(`"not-a-number"`)
	trace := selector.Trace{
		TraceID:        "00000000000000000000000000000001",
		Spans:          []redaction.RedactedSpan{span},
		RequestSpan:    span,
		HasRequestSpan: true,
	}
	sampler, err := sampling.NewSampler("graft-ai-otel-v1")
	if err != nil {
		t.Fatalf("new sampler: %v", err)
	}

	result, err := NewFanOut(sampler).Trace(trace, 1_000_000)
	if err != nil {
		t.Fatalf("Trace returned error for an invalid projected numeric field: %v", err)
	}
	if len(result.Tempo) != 1 || len(result.Metrics.Samples) == 0 {
		t.Fatalf("result = %#v, want Tempo and metrics despite payload field drop", result)
	}
}

func requestSpan(spanID string, request bool) redaction.RedactedSpan {
	flag := "false"
	if request {
		flag = "true"
	}
	return redaction.RedactedSpan{Span: redaction.Span{
		TraceID: spanID,
		SpanID:  spanID,
		Attributes: map[string]json.RawMessage{
			"graft_ai.request_span":   json.RawMessage(flag),
			"model":                   json.RawMessage(`"llama"`),
			"provider":                json.RawMessage(`"cloudflare"`),
			"status_code":             json.RawMessage(`200`),
			"env":                     json.RawMessage(`"prod"`),
			"gateway":                 json.RawMessage(`"main"`),
			redaction.PromptAttribute: json.RawMessage(`{"text":"safe prompt"}`),
		},
	}}
}

func TestTempoCopy_strips_prompt_completion_and_metadata_case_insensitively(t *testing.T) {
	span := redaction.RedactedSpan{Span: redaction.Span{
		TraceID: "trace",
		SpanID:  "span",
		Attributes: map[string]json.RawMessage{
			"prompt":                      json.RawMessage(`"secret"`),
			"Prompt":                      json.RawMessage(`"secret"`),
			"completion":                  json.RawMessage(`"secret"`),
			"COMPLETION":                  json.RawMessage(`"secret"`),
			"metadata":                    json.RawMessage(`"secret"`),
			"Metadata":                    json.RawMessage(`"secret"`),
			redaction.PromptAttribute:     json.RawMessage(`"secret"`),
			redaction.CompletionAttribute: json.RawMessage(`"secret"`),
			redaction.MetadataAttribute:   json.RawMessage(`"secret"`),
			"model":                       json.RawMessage(`"llama"`),
		},
	}}

	copied := tempoCopy(span)
	for _, key := range []string{
		"prompt", "Prompt",
		"completion", "COMPLETION",
		"metadata", "Metadata",
		redaction.PromptAttribute, redaction.CompletionAttribute, redaction.MetadataAttribute,
	} {
		if _, ok := copied.Attributes[key]; ok {
			t.Fatalf("tempoCopy retained sensitive attribute %q", key)
		}
	}
	if _, ok := copied.Attributes["model"]; !ok {
		t.Fatalf("tempoCopy removed non-sensitive attribute %q", "model")
	}
}
