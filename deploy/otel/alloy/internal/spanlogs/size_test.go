package spanlogs

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSizer_keeps_an_exactly_256KiB_json_line(t *testing.T) {
	fields := map[string]json.RawMessage{
		"trace_id": raw(`"00112233445566778899aabbccddeeff"`),
		"padding":  raw(`""`),
	}
	base, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal base record: %v", err)
	}
	fields["padding"] = json.RawMessage(strconv.Quote(strings.Repeat("x", MaxLineBytes-len(base))))
	record := JSONLogRecord{Fields: fields}

	finalized, reason := NewSizer(MaxLineBytes).Finalize(record)
	if reason != DropReasonNone {
		t.Fatalf("drop reason = %q, want none", reason)
	}
	if len(finalized.Serialized) != MaxLineBytes {
		t.Fatalf("serialized bytes = %d, want %d", len(finalized.Serialized), MaxLineBytes)
	}
	if !json.Valid(finalized.Serialized) {
		t.Fatal("exact-limit serialized line is invalid JSON")
	}
}

func TestSizer_truncates_both_payloads_with_utf8_safe_50_50_budget(t *testing.T) {
	record := JSONLogRecord{Fields: map[string]json.RawMessage{
		"trace_id":     raw(`"00112233445566778899aabbccddeeff"`),
		"input_tokens": raw(`12`),
		"prompt":       json.RawMessage(strconv.Quote(strings.Repeat("あ", MaxLineBytes))),
		"completion":   json.RawMessage(strconv.Quote(strings.Repeat("い", MaxLineBytes))),
	}}

	finalized, reason := NewSizer(MaxLineBytes).Finalize(record)
	if reason != DropReasonNone {
		t.Fatalf("drop reason = %q, want none", reason)
	}
	if len(finalized.Serialized) > MaxLineBytes {
		t.Fatalf("serialized bytes = %d, exceeds %d", len(finalized.Serialized), MaxLineBytes)
	}
	for _, field := range []string{"prompt", "completion"} {
		var value string
		if err := json.Unmarshal(finalized.Fields[field], &value); err != nil {
			t.Fatalf("decode %s: %v", field, err)
		}
		if !utf8.ValidString(value) || !strings.HasSuffix(value, "[TRUNCATED]") {
			t.Fatalf("%s was not UTF-8-safe truncated: valid=%v suffix=%v", field, utf8.ValidString(value), strings.HasSuffix(value, "[TRUNCATED]"))
		}
	}
	if string(finalized.Fields["payload_truncated"]) != "true" {
		t.Fatalf("payload_truncated = %s, want true", finalized.Fields["payload_truncated"])
	}
}

func TestSizer_allocates_equal_budgets_for_asymmetric_payloads(t *testing.T) {
	record := JSONLogRecord{Fields: map[string]json.RawMessage{
		"trace_id":   raw(`"00112233445566778899aabbccddeeff"`),
		"prompt":     json.RawMessage(strconv.Quote(strings.Repeat("p", 1000))),
		"completion": json.RawMessage(strconv.Quote(strings.Repeat("c", 9000))),
	}}

	finalized, reason := NewSizer(1024).Finalize(record)
	if reason != DropReasonNone {
		t.Fatalf("drop reason = %q, want none", reason)
	}
	if len(finalized.Serialized) > 1024 {
		t.Fatalf("serialized bytes = %d, exceeds %d", len(finalized.Serialized), 1024)
	}

	var prompt, completion string
	if err := json.Unmarshal(finalized.Fields["prompt"], &prompt); err != nil {
		t.Fatalf("decode prompt: %v", err)
	}
	if err := json.Unmarshal(finalized.Fields["completion"], &completion); err != nil {
		t.Fatalf("decode completion: %v", err)
	}
	if !strings.HasSuffix(prompt, "[TRUNCATED]") || !strings.HasSuffix(completion, "[TRUNCATED]") {
		t.Fatalf("expected both payloads truncated: promptSuffix=%v completionSuffix=%v", strings.HasSuffix(prompt, "[TRUNCATED]"), strings.HasSuffix(completion, "[TRUNCATED]"))
	}

	if len(completion) > len(prompt)+64 || len(prompt) > len(completion)+64 {
		t.Fatalf("payload budgets are not approximately equal: prompt=%d completion=%d", len(prompt), len(completion))
	}
}

func TestSizer_jsonStringByteSize_accounts_for_html_escaping(t *testing.T) {
	value := "a<b>c&d\u2028\u2029e"
	got := jsonStringByteSize(value)
	want := len(marshalString(value))
	if got != want {
		t.Fatalf("jsonStringByteSize(%q) = %d, want %d", value, got, want)
	}
}

func TestSizer_uses_100_0_budget_when_only_one_payload_exists(t *testing.T) {
	record := JSONLogRecord{Fields: map[string]json.RawMessage{
		"trace_id": raw(`"00112233445566778899aabbccddeeff"`),
		"prompt":   json.RawMessage(strconv.Quote(strings.Repeat("x", MaxLineBytes))),
	}}

	finalized, reason := NewSizer(MaxLineBytes).Finalize(record)
	if reason != DropReasonNone {
		t.Fatalf("drop reason = %q, want none", reason)
	}
	var prompt string
	if err := json.Unmarshal(finalized.Fields["prompt"], &prompt); err != nil {
		t.Fatalf("decode prompt: %v", err)
	}
	if !strings.HasSuffix(prompt, "[TRUNCATED]") {
		t.Fatalf("prompt was not truncated: %s", prompt[len(prompt)-min(len(prompt), 20):])
	}
	if len(finalized.Serialized) > MaxLineBytes {
		t.Fatalf("serialized bytes = %d, exceeds %d", len(finalized.Serialized), MaxLineBytes)
	}
}

func TestSizer_drops_record_when_metadata_alone_exceeds_limit(t *testing.T) {
	record := JSONLogRecord{Fields: map[string]json.RawMessage{
		"trace_id": raw(`"` + strings.Repeat("x", MaxLineBytes) + `"`),
		"prompt":   raw(`"payload"`),
	}}

	finalized, reason := NewSizer(MaxLineBytes).Finalize(record)
	if reason != DropReasonLineSizeMetadata {
		t.Fatalf("drop reason = %q, want line_size_metadata", reason)
	}
	if finalized.Serialized != nil {
		t.Fatalf("metadata overflow produced serialized output")
	}
}

func TestSizer_dropped_record_removes_truncated_marker(t *testing.T) {
	// Use a record where metadata fits but base with empty payloads does not,
	// so dropPayload is reached via the line_size path.
	record := JSONLogRecord{Fields: map[string]json.RawMessage{
		"trace_id":   raw(`"00112233445566778899aabbccddeeff"`),
		"prompt":     raw(`"` + strings.Repeat("x", 1024) + `"`),
		"completion": raw(`"` + strings.Repeat("y", 1024) + `"`),
	}}
	finalized, reason := NewSizer(104).Finalize(record)
	if reason != DropReasonLineSize {
		t.Fatalf("drop reason = %q, want line_size", reason)
	}
	if string(finalized.Fields["payload_truncated"]) == "true" {
		t.Fatalf("dropped record still has payload_truncated")
	}
	if string(finalized.Fields["payload_dropped"]) != "true" {
		t.Fatalf("payload_dropped = %s, want true", finalized.Fields["payload_dropped"])
	}
}

func TestSizer_decodeNode_rejects_deeply_nested_json(t *testing.T) {
	deep := []byte(`{"a":` + strings.Repeat(`{"b":`, maxJSONDepth+1) + `null` + strings.Repeat(`}`, maxJSONDepth+1) + `}`)
	if _, err := decodeNode(deep); err == nil {
		t.Fatal("expected error for deeply nested JSON")
	}
}

func BenchmarkFinalize_worst_case_payload(b *testing.B) {
	prompt := json.RawMessage(strconv.Quote(strings.Repeat("あ", MaxLineBytes)))
	completion := json.RawMessage(strconv.Quote(strings.Repeat("い", MaxLineBytes)))
	record := JSONLogRecord{Fields: map[string]json.RawMessage{
		"trace_id":     raw(`"00112233445566778899aabbccddeeff"`),
		"input_tokens": raw(`12`),
		"prompt":       prompt,
		"completion":   completion,
	}}
	sizer := NewSizer(MaxLineBytes)
	b.ReportAllocs()
	for b.Loop() {
		finalized, _ := sizer.Finalize(record)
		_ = finalized.Serialized
	}
}
