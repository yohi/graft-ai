package redaction

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRedactor_masks_credentials_in_nested_payloads_and_attributes(t *testing.T) {
	span := Span{
		TraceID: "00112233445566778899aabbccddeeff",
		SpanID:  "0112233445566778",
		Attributes: map[string]json.RawMessage{
			"gen_ai.prompt_json": rawJSON(t, `{"prompt":"ordinary prompt\nwith \"quotes\"","nested":{"api_key":"sk-live-secret"}}`),
			"password":           rawJSON(t, `"plain-secret"`),
			"safe":               rawJSON(t, `"keep whitespace   and newline\n"`),
		},
		ResourceAttributes: map[string]json.RawMessage{
			"authorization": rawJSON(t, `"Bearer resource-secret"`),
			"service.name":  rawJSON(t, `"gateway"`),
		},
	}

	redacted, status := NewRedactor().Redact(span)
	if status.PayloadDropped {
		t.Fatalf("payload dropped: %#v", status)
	}
	prompt := string(redacted.Attributes["gen_ai.prompt_json"])
	if strings.Contains(prompt, "sk-live-secret") || !strings.Contains(prompt, "[REDACTED]") {
		t.Fatalf("prompt redaction = %s", prompt)
	}
	if got := string(redacted.Attributes["password"]); got != `"[REDACTED]"` {
		t.Fatalf("explicit secret attribute = %s, want redacted", got)
	}
	if got := string(redacted.Attributes["safe"]); got != `"keep whitespace   and newline\n"` {
		t.Fatalf("safe attribute changed = %s", got)
	}
	if got := string(redacted.ResourceAttributes["authorization"]); got != `"[REDACTED]"` {
		t.Fatalf("resource authorization = %s, want redacted", got)
	}
	if got := string(redacted.ResourceAttributes["service.name"]); got != `"gateway"` {
		t.Fatalf("safe resource attribute = %s", got)
	}
}

func TestRedactor_masks_known_credential_patterns_without_dropping_prompt(t *testing.T) {
	patterns := []string{
		"Authorization: Bearer bearer-secret",
		"Authorization: Basic basic-secret",
		"sk-proj-api-secret",
		"AKIAIOSFODNN7EXAMPLE",
		"api_key=api-secret",
	}
	for _, pattern := range patterns {
		t.Run(pattern, func(t *testing.T) {
			span := Span{Attributes: map[string]json.RawMessage{
				"gen_ai.prompt_json": rawJSON(t, `{"text":"`+pattern+`"}`),
			}}
			redacted, status := NewRedactor().Redact(span)
			if status.PayloadDropped {
				t.Fatalf("credential-like prompt was dropped: %#v", status)
			}
			value := string(redacted.Attributes["gen_ai.prompt_json"])
			if strings.Contains(value, pattern) || !strings.Contains(value, "[REDACTED]") {
				t.Fatalf("pattern was not redacted: %s", value)
			}
		})
	}
}

func TestRedactor_drops_only_malformed_payload_attributes(t *testing.T) {
	span := Span{
		Attributes: map[string]json.RawMessage{
			"gen_ai.prompt_json": json.RawMessage(`{"unclosed":`),
			"model":              rawJSON(t, `"llama"`),
		},
	}

	redacted, status := NewRedactor().Redact(span)
	if !status.PayloadDropped || status.PayloadDropReason != "redaction_failure" {
		t.Fatalf("status = %#v, want redaction_failure", status)
	}
	if _, ok := redacted.Attributes["gen_ai.prompt_json"]; ok {
		t.Fatalf("malformed payload was preserved")
	}
	if got := string(redacted.Attributes["model"]); got != `"llama"` {
		t.Fatalf("safe metadata = %s", got)
	}
}

func TestRedactor_preserves_safe_numeric_usage_metadata(t *testing.T) {
	span := Span{Attributes: map[string]json.RawMessage{
		"gen_ai.usage.input_tokens":  rawJSON(t, `12`),
		"gen_ai.usage.output_tokens": rawJSON(t, `8`),
		"gen_ai.usage.cost_usd":      rawJSON(t, `0.25`),
	}}

	redacted, status := NewRedactor().Redact(span)
	if status.PayloadDropped {
		t.Fatalf("safe metadata was dropped: %#v", status)
	}
	for key, want := range map[string]string{
		"gen_ai.usage.input_tokens":  "12",
		"gen_ai.usage.output_tokens": "8",
		"gen_ai.usage.cost_usd":      "0.25",
	} {
		if got := string(redacted.Attributes[key]); got != want {
			t.Fatalf("%s = %s, want %s", key, got, want)
		}
	}
}

func rawJSON(t *testing.T, value string) json.RawMessage {
	t.Helper()
	if !json.Valid([]byte(value)) {
		t.Fatalf("invalid test JSON: %s", value)
	}
	return json.RawMessage(value)
}

func TestRedactor_rejects_deeply_nested_payload(t *testing.T) {
	deep := []byte(`{"a":` + strings.Repeat(`{"b":`, maxJSONDepth+1) + `null` + strings.Repeat(`}`, maxJSONDepth+1) + `}`)
	span := Span{Attributes: map[string]json.RawMessage{
		"gen_ai.prompt_json": deep,
	}}

	redacted, status := NewRedactor().Redact(span)
	if !status.PayloadDropped || status.PayloadDropReason != "redaction_failure" {
		t.Fatalf("status = %#v, want redaction_failure", status)
	}
	if _, ok := redacted.Attributes["gen_ai.prompt_json"]; ok {
		t.Fatalf("deeply nested payload was preserved")
	}
}
