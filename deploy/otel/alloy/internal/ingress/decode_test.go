package ingress

import (
	"encoding/json"
	"math"
	"testing"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func TestAnyValueJSON_handles_non_finite_double_values(t *testing.T) {
	tests := []struct {
		name  string
		value float64
	}{
		{name: "NaN", value: math.NaN()},
		{name: "positive infinity", value: math.Inf(1)},
		{name: "negative infinity", value: math.Inf(-1)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			value := &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: tt.value}}
			got := anyValueJSON(value)
			if string(got) != "null" {
				t.Fatalf("anyValueJSON(non-finite) = %q, want null", got)
			}
			if !json.Valid(got) {
				t.Fatalf("anyValueJSON(non-finite) returned invalid JSON: %q", got)
			}
		})
	}
}

func TestAnyValueJSON_preserves_finite_double_value(t *testing.T) {
	value := &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: 3.14}}
	got := anyValueJSON(value)
	var parsed float64
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("json.Unmarshal(%q): %v", got, err)
	}
	if parsed != 3.14 {
		t.Fatalf("parsed value = %v, want 3.14", parsed)
	}
}

func TestDecodeSpans_projects_every_valid_span_individually(t *testing.T) {
	body := validMultiSpanOTLPBody(t, "protobuf")
	spans, err := decodeSpans(body, "application/x-protobuf")
	if err != nil {
		t.Fatalf("decode spans: %v", err)
	}
	if len(spans) != 2 {
		t.Fatalf("got %d spans, want 2", len(spans))
	}
	wantTraceIDs := []string{"00112233445566778899aabbccddeeff", "ffeeddccbbaa99887766554433221100"}
	for i, want := range wantTraceIDs {
		if spans[i].TraceID != want {
			t.Fatalf("span[%d].TraceID = %q, want %q", i, spans[i].TraceID, want)
		}
	}
}

func TestDecodeSpans_skips_invalid_trace_ids(t *testing.T) {
	body := mixedTraceOTLPBody(t)
	spans, err := decodeSpans(body, "application/x-protobuf")
	if err != nil {
		t.Fatalf("decode spans: %v", err)
	}
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if spans[0].TraceID != "00112233445566778899aabbccddeeff" {
		t.Fatalf("TraceID = %q, want valid trace id", spans[0].TraceID)
	}
}

func TestDecodeSpans_normalizes_proto_request_fields_for_selector(t *testing.T) {
	payload := validRequestSpanOTLPBody(t)

	spans, err := decodeSpans(payload, "application/x-protobuf")
	if err != nil {
		t.Fatalf("decode spans: %v", err)
	}
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	span := spans[0]
	if got := string(span.Attributes["span.kind"]); got != `"server"` {
		t.Fatalf("span.kind = %s, want server attribute", got)
	}
	if got := string(span.Attributes["parent_span_id"]); got != `""` {
		t.Fatalf("parent_span_id = %s, want empty root value", got)
	}
	if span.Name != "request" {
		t.Fatalf("name = %q, want request", span.Name)
	}
}

func validRequestSpanOTLPBody(t *testing.T) []byte {
	t.Helper()
	payload := &collectortracepb.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			ScopeSpans: []*tracepb.ScopeSpans{{
				Spans: []*tracepb.Span{{
					TraceId: []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff},
					SpanId:  []byte{0x01, 0x12, 0x23, 0x34, 0x45, 0x56, 0x67, 0x78},
					Name:    "request",
					Kind:    tracepb.Span_SPAN_KIND_SERVER,
				}},
			}},
		}},
	}
	body, err := proto.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal OTLP protobuf: %v", err)
	}
	return body
}
