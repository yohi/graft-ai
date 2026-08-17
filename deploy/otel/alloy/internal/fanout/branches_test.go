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
