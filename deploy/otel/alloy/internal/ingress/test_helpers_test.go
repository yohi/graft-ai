package ingress

import (
	"encoding/json"
	"testing"
	"time"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func newTestReceiver(t *testing.T, queueCapacity int) (*Receiver, *IngressQueue) {
	t.Helper()
	authenticator, err := NewBearerAuthenticator("ingest-token")
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}
	identity, err := NewSourceIdentity([]string{"127.0.0.1/32"}, []byte("hmac-key"))
	if err != nil {
		t.Fatalf("new source identity: %v", err)
	}
	queue, err := NewIngressQueue(queueCapacity)
	if err != nil {
		t.Fatalf("new queue: %v", err)
	}
	limiter, err := NewRateLimiter(RateLimiterConfig{
		Capacity:        20,
		RefillPerSecond: 2,
		Now:             func() time.Time { return time.Unix(0, 0) },
	})
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}
	receiver, err := NewReceiver(ReceiverConfig{
		Authenticator:         authenticator,
		SourceIdentity:        identity,
		Queue:                 queue,
		RateLimiter:           limiter,
		MaxBodyBytes:          8 * 1024 * 1024,
		MaxConcurrentRequests: 100,
	})
	if err != nil {
		t.Fatalf("new receiver: %v", err)
	}
	return receiver, queue
}

func validOTLPBody(t *testing.T, encoding string) []byte {
	t.Helper()
	payload := &collectortracepb.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			ScopeSpans: []*tracepb.ScopeSpans{{
				Spans: []*tracepb.Span{{
					TraceId: []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff},
					SpanId:  []byte{0x01, 0x12, 0x23, 0x34, 0x45, 0x56, 0x67, 0x78},
					Name:    "request",
				}},
			}},
		}},
	}
	if encoding == "json" {
		body, err := protojson.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal OTLP JSON: %v", err)
		}
		return body
	}
	body, err := proto.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal OTLP protobuf: %v", err)
	}
	return body
}

func assertReason(t *testing.T, body []byte, want string) {
	t.Helper()
	var response struct {
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if response.Reason != want {
		t.Fatalf("reason = %q, want %q", response.Reason, want)
	}
}
