package wire

import (
	"encoding/json"
	"testing"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

func TestEncodeTempo_groups_spans_by_resource_attributes(t *testing.T) {
	spans := []redaction.RedactedSpan{
		{Span: redaction.Span{
			TraceID:            "00112233445566778899aabbccddeeff",
			SpanID:             "0102030405060708",
			Name:               "service-a-span",
			ResourceAttributes: map[string]json.RawMessage{"service.name": raw(`"service-a"`)},
		}},
		{Span: redaction.Span{
			TraceID:            "00112233445566778899aabbccddeeff",
			SpanID:             "1112131415161718",
			Name:               "service-b-span",
			ResourceAttributes: map[string]json.RawMessage{"service.name": raw(`"service-b"`)},
		}},
		{Span: redaction.Span{
			TraceID:            "00112233445566778899aabbccddeeff",
			SpanID:             "2122232425262728",
			Name:               "service-a-span-2",
			ResourceAttributes: map[string]json.RawMessage{"service.name": raw(`"service-a"`)},
		}},
	}

	payload, err := EncodeTempo(spans)
	if err != nil {
		t.Fatalf("EncodeTempo: %v", err)
	}

	var request collectortracepb.ExportTraceServiceRequest
	if err := proto.Unmarshal(payload, &request); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(request.ResourceSpans) != 2 {
		t.Fatalf("got %d ResourceSpans, want 2", len(request.ResourceSpans))
	}

	serviceCount := map[string]int{}
	for _, rs := range request.ResourceSpans {
		svc := ""
		for _, attr := range rs.Resource.Attributes {
			if attr.Key == "service.name" {
				svc = attr.Value.GetStringValue()
			}
		}
		if svc == "" {
			t.Fatalf("missing service.name in resource attributes")
		}
		serviceCount[svc] += len(rs.ScopeSpans[0].Spans)
	}

	want := map[string]int{"service-a": 2, "service-b": 1}
	if len(serviceCount) != len(want) {
		t.Fatalf("serviceCount = %v, want %v", serviceCount, want)
	}
	for svc, count := range want {
		if serviceCount[svc] != count {
			t.Fatalf("serviceCount[%q] = %d, want %d", svc, serviceCount[svc], count)
		}
	}
}

func TestEncodeTempo_keeps_single_resource_for_identical_attributes(t *testing.T) {
	spans := []redaction.RedactedSpan{
		{Span: redaction.Span{
			TraceID:            "00112233445566778899aabbccddeeff",
			SpanID:             "0102030405060708",
			Name:               "span-1",
			ResourceAttributes: map[string]json.RawMessage{"service.name": raw(`"single"`)},
		}},
		{Span: redaction.Span{
			TraceID:            "00112233445566778899aabbccddeeff",
			SpanID:             "1112131415161718",
			Name:               "span-2",
			ResourceAttributes: map[string]json.RawMessage{"service.name": raw(`"single"`)},
		}},
	}

	payload, err := EncodeTempo(spans)
	if err != nil {
		t.Fatalf("EncodeTempo: %v", err)
	}

	var request collectortracepb.ExportTraceServiceRequest
	if err := proto.Unmarshal(payload, &request); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(request.ResourceSpans) != 1 {
		t.Fatalf("got %d ResourceSpans, want 1", len(request.ResourceSpans))
	}
	if len(request.ResourceSpans[0].ScopeSpans[0].Spans) != 2 {
		t.Fatalf("got %d spans, want 2", len(request.ResourceSpans[0].ScopeSpans[0].Spans))
	}
}
