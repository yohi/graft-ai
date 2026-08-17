package ingress

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReceiver_accepts_protobuf_and_enqueues_asynchronously(t *testing.T) {
	receiver, queue := newTestReceiver(t, 2)
	body := validOTLPBody(t, "protobuf")
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
	if !ok || envelope.TraceID != "00112233445566778899aabbccddeeff" {
		t.Fatalf("envelope = %#v, ok = %v", envelope, ok)
	}
}

func TestReceiver_accepts_json_and_preserves_content_type(t *testing.T) {
	receiver, queue := newTestReceiver(t, 2)
	body := validOTLPBody(t, "json")
	request := httptest.NewRequest(http.MethodPost, "http://example.test/v1/traces", bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:4318"
	request.Header.Set("Authorization", "Bearer ingest-token")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	receiver.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	envelope, ok := queue.Dequeue(request.Context())
	if !ok || envelope.ContentType != "application/json" {
		t.Fatalf("envelope = %#v, ok = %v", envelope, ok)
	}
}

func TestReceiver_returns_contract_status_reasons(t *testing.T) {
	tests := []struct {
		name       string
		path       string
		method     string
		remoteAddr string
		authority  string
		content    string
		encoding   string
		body       []byte
		wantStatus int
		wantReason string
	}{
		{name: "missing auth", path: "/v1/traces", method: http.MethodPost, remoteAddr: "127.0.0.1:4318", content: "application/x-protobuf", body: []byte("bad"), wantStatus: 401, wantReason: "auth"},
		{name: "untrusted source", path: "/v1/traces", method: http.MethodPost, remoteAddr: "198.51.100.1:4318", authority: "Bearer ingest-token", content: "application/x-protobuf", body: []byte("bad"), wantStatus: 403, wantReason: "untrusted_source"},
		{name: "unknown path", path: "/health", method: http.MethodPost, remoteAddr: "127.0.0.1:4318", authority: "Bearer ingest-token", content: "application/x-protobuf", body: []byte("bad"), wantStatus: 404, wantReason: "path"},
		{name: "wrong method", path: "/v1/traces", method: http.MethodGet, remoteAddr: "127.0.0.1:4318", authority: "Bearer ingest-token", content: "application/x-protobuf", body: []byte("bad"), wantStatus: 405, wantReason: "method"},
		{name: "malformed payload", path: "/v1/traces", method: http.MethodPost, remoteAddr: "127.0.0.1:4318", authority: "Bearer ingest-token", content: "application/x-protobuf", body: []byte("bad"), wantStatus: 400, wantReason: "parse"},
		{name: "content type mismatch", path: "/v1/traces", method: http.MethodPost, remoteAddr: "127.0.0.1:4318", authority: "Bearer ingest-token", content: "text/plain", body: []byte("bad"), wantStatus: 415, wantReason: "content_type"},
		{name: "compression", path: "/v1/traces", method: http.MethodPost, remoteAddr: "127.0.0.1:4318", authority: "Bearer ingest-token", content: "application/x-protobuf", encoding: "gzip", body: []byte("bad"), wantStatus: 415, wantReason: "compression"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			receiver, _ := newTestReceiver(t, 2)
			request := httptest.NewRequest(tt.method, "http://example.test"+tt.path, bytes.NewReader(tt.body))
			request.RemoteAddr = tt.remoteAddr
			request.Header.Set("Authorization", tt.authority)
			request.Header.Set("Content-Type", tt.content)
			if tt.encoding != "" {
				request.Header.Set("Content-Encoding", tt.encoding)
			}
			response := httptest.NewRecorder()

			receiver.ServeHTTP(response, request)

			if response.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, tt.wantStatus)
			}
			if tt.wantStatus == http.StatusMethodNotAllowed {
				if got := response.Header().Get("Allow"); got != http.MethodPost {
					t.Fatalf("Allow header = %q, want %q", got, http.MethodPost)
				}
			}
			assertReason(t, response.Body.Bytes(), tt.wantReason)
		})
	}
}

func TestReceiver_returns_413_when_body_exceeds_limit(t *testing.T) {
	receiver, _ := newTestReceiver(t, 2)
	body := bytes.Repeat([]byte("x"), 8*1024*1024+1)
	request := httptest.NewRequest(http.MethodPost, "http://example.test/v1/traces", bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:4318"
	request.Header.Set("Authorization", "Bearer ingest-token")
	request.Header.Set("Content-Type", "application/x-protobuf")
	response := httptest.NewRecorder()

	receiver.ServeHTTP(response, request)

	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", response.Code)
	}
	assertReason(t, response.Body.Bytes(), "body_size")
}

func TestReceiver_returns_200_capacity_reason_when_queue_is_full(t *testing.T) {
	receiver, _ := newTestReceiver(t, 1)
	body := validOTLPBody(t, "protobuf")
	var lastResponse *httptest.ResponseRecorder

	for range 2 {
		request := httptest.NewRequest(http.MethodPost, "http://example.test/v1/traces", bytes.NewReader(body))
		request.RemoteAddr = "127.0.0.1:4318"
		request.Header.Set("Authorization", "Bearer ingest-token")
		request.Header.Set("Content-Type", "application/x-protobuf")
		response := httptest.NewRecorder()
		receiver.ServeHTTP(response, request)
		lastResponse = response
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", response.Code)
		}
	}
	if got := lastResponse.Header().Get("X-OTel-Drop-Reason"); got != "capacity" {
		t.Fatalf("drop reason = %q, want capacity", got)
	}
	if got := lastResponse.Header().Get("X-OTel-Reason"); got != "capacity" {
		t.Fatalf("reason = %q, want capacity", got)
	}
	if got := receiver.Metrics().CapacityDrops; got != 1 {
		t.Fatalf("capacity drops = %d, want 1", got)
	}
}

func TestReceiver_returns_429_with_integer_retry_after_when_source_bucket_is_empty(t *testing.T) {
	receiver, _ := newTestReceiver(t, 64)
	body := validOTLPBody(t, "protobuf")
	for index := range 20 {
		request := httptest.NewRequest(http.MethodPost, "http://example.test/v1/traces", bytes.NewReader(body))
		request.RemoteAddr = "127.0.0.1:4318"
		request.Header.Set("Authorization", "Bearer ingest-token")
		request.Header.Set("Content-Type", "application/x-protobuf")
		response := httptest.NewRecorder()
		receiver.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want 200", index, response.Code)
		}
	}

	request := httptest.NewRequest(http.MethodPost, "http://example.test/v1/traces", bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:4318"
	request.Header.Set("Authorization", "Bearer ingest-token")
	request.Header.Set("Content-Type", "application/x-protobuf")
	response := httptest.NewRecorder()
	receiver.ServeHTTP(response, request)

	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", response.Code)
	}
	if got := response.Header().Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want integer 1", got)
	}
	assertReason(t, response.Body.Bytes(), "rate_limit")
	if got := receiver.Metrics().RateLimited; got != 1 {
		t.Fatalf("rate-limited count = %d, want 1", got)
	}
}
