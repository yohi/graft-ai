package selector

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

func TestRequestSelector_elects_one_request_span_with_start_and_span_id_tiebreaks(t *testing.T) {
	selector, err := NewRequestSelector(10_000, 64*1024*1024, time.Second)
	if err != nil {
		t.Fatalf("new selector: %v", err)
	}
	now := time.Unix(100, 0)
	spans := []redaction.RedactedSpan{
		testSpan("trace", "b", 10, map[string]json.RawMessage{"span.kind": raw(`"server"`)}),
		testSpan("trace", "a", 10, map[string]json.RawMessage{"span.kind": raw(`"server"`)}),
		testSpan("trace", "child", 11, map[string]json.RawMessage{
			"span.kind":      raw(`"client"`),
			"request_id":     raw(`"request-1"`),
			"parent_span_id": raw(`"a"`),
		}),
	}
	for _, span := range spans {
		selector.AddAt(span, now)
	}

	flushed := selector.FlushIdle(now.Add(time.Second))
	if len(flushed) != 1 {
		t.Fatalf("flushed traces = %d, want 1", len(flushed))
	}
	trace := flushed[0]
	if !trace.HasRequestSpan || trace.RequestSpan.SpanID != "a" {
		t.Fatalf("request span = %#v, want span a", trace.RequestSpan)
	}
	for _, span := range trace.Spans {
		want := span.SpanID == "a"
		if got := string(span.Attributes["graft_ai.request_span"]); got != boolJSON(want) {
			t.Fatalf("span %s request flag = %s, want %s", span.SpanID, got, boolJSON(want))
		}
	}
}

func TestRequestSelector_flushes_only_after_one_second_idle(t *testing.T) {
	selector, err := NewRequestSelector(10_000, 64*1024*1024, time.Second)
	if err != nil {
		t.Fatalf("new selector: %v", err)
	}
	now := time.Unix(100, 0)
	selector.AddAt(testSpan("trace", "span", 1, map[string]json.RawMessage{
		"span.kind": raw(`"server"`),
	}), now)
	if got := selector.FlushIdle(now.Add(999 * time.Millisecond)); len(got) != 0 {
		t.Fatalf("early flush returned %d traces", len(got))
	}
	if got := selector.FlushIdle(now.Add(time.Second)); len(got) != 1 {
		t.Fatalf("idle flush returned %d traces, want 1", len(got))
	}
}

func TestRequestSelector_evicts_oldest_trace_when_trace_or_byte_limit_is_reached(t *testing.T) {
	selector, err := NewRequestSelector(2, 400, time.Second)
	if err != nil {
		t.Fatalf("new selector: %v", err)
	}
	now := time.Unix(100, 0)
	selector.AddAt(testSpan("first", "span-1", 1, map[string]json.RawMessage{
		"span.kind": raw(`"server"`),
	}), now)
	selector.AddAt(testSpan("second", "span-2", 2, map[string]json.RawMessage{
		"span.kind": raw(`"server"`),
	}), now.Add(time.Second))
	evictions := selector.AddAt(testSpan("third", "span-3", 3, map[string]json.RawMessage{
		"span.kind": raw(`"server"`),
	}), now.Add(2*time.Second))
	if len(evictions) != 1 || evictions[0].TraceID != "first" || evictions[0].Reason != "trace_state_evicted" {
		t.Fatalf("evictions = %#v", evictions)
	}
	if selector.Len() != 2 {
		t.Fatalf("trace count = %d, want 2", selector.Len())
	}

	byteLimited, err := NewRequestSelector(10, 50, time.Second)
	if err != nil {
		t.Fatalf("new byte-limited selector: %v", err)
	}
	byteEvictions := byteLimited.AddAt(testSpan("large", "span", 1, map[string]json.RawMessage{
		"span.kind": raw(`"server"`),
		"payload":   raw(`"this makes the trace state exceed the byte limit"`),
	}), now)
	if len(byteEvictions) != 1 || byteEvictions[0].Reason != "trace_state_evicted" {
		t.Fatalf("byte evictions = %#v", byteEvictions)
	}
}

func testSpan(traceID, spanID string, start uint64, attributes map[string]json.RawMessage) redaction.RedactedSpan {
	return redaction.RedactedSpan{Span: redaction.Span{
		TraceID:       traceID,
		SpanID:        spanID,
		StartUnixNano: start,
		EndUnixNano:   start + 1,
		Attributes:    attributes,
	}}
}

func raw(value string) json.RawMessage { return json.RawMessage(value) }

func boolJSON(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
