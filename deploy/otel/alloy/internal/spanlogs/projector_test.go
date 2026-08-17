package spanlogs

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

func TestProjector_emits_only_allowlisted_fields_and_fixed_labels(t *testing.T) {
	span := redaction.RedactedSpan{
		Span: redaction.Span{
			TraceID: "00112233445566778899aabbccddeeff",
			SpanID:  "0112233445566778",
			Attributes: map[string]json.RawMessage{
				"request_id":                 raw(`"request-1"`),
				"model":                      raw(`"llama"`),
				"provider":                   raw(`"cloudflare"`),
				"status":                     raw(`"OK"`),
				"status_code":                raw(`200`),
				"gateway":                    raw(`"main"`),
				"env":                        raw(`"prod"`),
				"gen_ai.usage.input_tokens":  raw(`12`),
				"gen_ai.usage.output_tokens": raw(`8`),
				"gen_ai.usage.total_tokens":  raw(`20`),
				"gen_ai.usage.cost_usd":      raw(`0.25`),
				"duration_ms":                raw(`42.5`),
				"gen_ai.prompt_json":         raw(`{"text":"hello"}`),
				"not_allowlisted":            raw(`"must not appear"`),
			},
		},
	}

	record, reason := NewProjector().ProjectRequestSpan(span)
	if reason != DropReasonNone {
		t.Fatalf("drop reason = %q, want none", reason)
	}
	wantLabels := map[string]string{
		"model":       "llama",
		"status_code": "200",
		"env":         "prod",
		"gateway":     "main",
	}
	if !reflect.DeepEqual(record.Labels, wantLabels) {
		t.Fatalf("labels = %#v, want %#v", record.Labels, wantLabels)
	}
	for _, key := range []string{"trace_id", "span_id", "request_id", "model", "provider", "status", "status_code", "input_tokens", "output_tokens", "total_tokens", "cost_usd", "duration_ms", "prompt"} {
		if _, ok := record.Fields[key]; !ok {
			t.Fatalf("allowlisted field %q is missing", key)
		}
	}
	if _, ok := record.Fields["not_allowlisted"]; ok {
		t.Fatalf("non-allowlisted attribute was projected")
	}
	if _, ok := record.Fields["trace_id"]; !ok {
		t.Fatalf("trace_id was not projected")
	}
}

func TestProjector_drops_invalid_numeric_field_without_invalid_json(t *testing.T) {
	span := redaction.RedactedSpan{Span: redaction.Span{
		TraceID: "00112233445566778899aabbccddeeff",
		Attributes: map[string]json.RawMessage{
			"model":                 raw(`"llama"`),
			"gen_ai.usage.cost_usd": raw(`"NaN"`),
			"gen_ai.prompt_json":    raw(`{"text":"safe"}`),
		},
	}}

	record, reason := NewProjector().ProjectRequestSpan(span)
	if reason != DropReasonNumericFieldInvalid {
		t.Fatalf("drop reason = %q, want numeric_field_invalid", reason)
	}
	if _, ok := record.Fields["cost_usd"]; ok {
		t.Fatalf("invalid numeric field was retained")
	}
	if string(record.Fields["payload_dropped"]) != "true" {
		t.Fatalf("payload_dropped = %s, want true", record.Fields["payload_dropped"])
	}
	if string(record.Fields["payload_drop_reason"]) != `"numeric_field_invalid"` {
		t.Fatalf("payload_drop_reason = %s", record.Fields["payload_drop_reason"])
	}
}

func raw(value string) json.RawMessage {
	return json.RawMessage(value)
}
