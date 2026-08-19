package ingress

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReceiver_returns_408_when_context_cancels_while_concurrency_is_full(t *testing.T) {
	receiver, _ := newTestReceiver(t, 2)
	for range 100 {
		receiver.concurrency <- struct{}{}
	}
	defer func() {
		for range 100 {
			<-receiver.concurrency
		}
	}()

	body := validOTLPBody(t, "protobuf")
	request := httptest.NewRequest(http.MethodPost, "http://example.test/v1/traces", bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:4318"
	request.Header.Set("Authorization", "Bearer ingest-token")
	request.Header.Set("Content-Type", "application/x-protobuf")
	requestContext, cancel := context.WithCancel(request.Context())
	request = request.WithContext(requestContext)
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		receiver.ServeHTTP(response, request)
		close(done)
	}()

	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("receiver did not observe request cancellation")
	}
	if response.Code != http.StatusRequestTimeout {
		t.Fatalf("status = %d, want 408", response.Code)
	}
	assertReason(t, response.Body.Bytes(), "timeout")
}

func TestReceiver_returns_408_when_body_reader_times_out(t *testing.T) {
	receiver, _ := newTestReceiver(t, 2)
	request := httptest.NewRequest(http.MethodPost, "http://example.test/v1/traces", timeoutBodyReader{})
	request.RemoteAddr = "127.0.0.1:4318"
	request.Header.Set("Authorization", "Bearer ingest-token")
	request.Header.Set("Content-Type", "application/x-protobuf")
	response := httptest.NewRecorder()

	receiver.ServeHTTP(response, request)

	if response.Code != http.StatusRequestTimeout {
		t.Fatalf("status = %d, want 408", response.Code)
	}
	assertReason(t, response.Body.Bytes(), "timeout")
}

type timeoutBodyReader struct{}

func (timeoutBodyReader) Read([]byte) (int, error) { return 0, timeoutReadError{} }

type timeoutReadError struct{}

func (timeoutReadError) Error() string   { return "body read timeout" }
func (timeoutReadError) Timeout() bool   { return true }
func (timeoutReadError) Temporary() bool { return true }
