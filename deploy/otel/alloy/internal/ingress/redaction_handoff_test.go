package ingress

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func TestReceiver_redacts_and_serializes_before_queue_handoff(t *testing.T) {
	receiver, queue := newTestReceiver(t, 2)
	body := redactionPayload(t)
	request := httptest.NewRequest(http.MethodPost, "http://example.test/v1/traces", bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:4318"
	request.Header.Set("Authorization", "Bearer ingest-token")
	request.Header.Set("Content-Type", "application/x-protobuf")
	response := httptest.NewRecorder()

	receiver.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	envelope, ok := queue.Dequeue(request.Context())
	if !ok {
		t.Fatal("redacted envelope was not enqueued")
	}
	if envelope.SamplingRatePPM != 500_000 {
		t.Fatalf("queued sampling rate ppm = %d, want 500000", envelope.SamplingRatePPM)
	}
	if len(envelope.Spans) != 1 || envelope.Spans[0].TraceID != "00112233445566778899aabbccddeeff" {
		t.Fatalf("queued redacted spans = %#v", envelope.Spans)
	}
	redactedPrompt := string(envelope.Spans[0].Attributes["gen_ai.prompt_json"])
	if strings.Contains(redactedPrompt, "sk-live-secret") {
		t.Fatalf("raw credential reached queued redacted span")
	}
	if !json.Valid(envelope.Spans[0].Attributes["gen_ai.prompt_json"]) {
		t.Fatalf("queued redacted prompt is invalid JSON: %s", redactedPrompt)
	}
	if strings.Contains(redactedPrompt, "Bearer prompt-secret") {
		t.Fatalf("raw credential reached queue: %s", redactedPrompt)
	}
	if !strings.Contains(redactedPrompt, "[REDACTED]") {
		t.Fatalf("redacted marker is missing: %s", redactedPrompt)
	}
}

func redactionPayload(t *testing.T) []byte {
	t.Helper()
	payload := &collectortracepb.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			ScopeSpans: []*tracepb.ScopeSpans{{
				Spans: []*tracepb.Span{{
					TraceId: []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff},
					SpanId:  []byte{0x01, 0x12, 0x23, 0x34, 0x45, 0x56, 0x67, 0x78},
					Attributes: []*commonpb.KeyValue{
						{Key: "model", Value: stringValue("llama")},
						{Key: "gen_ai.prompt_json", Value: stringValue(`{"prompt":"Bearer prompt-secret","key":"sk-live-secret"}`)},
					},
				}},
			}},
		}},
	}
	body, err := proto.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return body
}

func stringValue(value string) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}}
}
