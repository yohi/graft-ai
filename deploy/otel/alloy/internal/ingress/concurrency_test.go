package ingress

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestReceiver_limits_active_request_bodies_to_100(t *testing.T) {
	authenticator, err := NewBearerAuthenticator("ingest-token")
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}
	identity, err := NewSourceIdentity([]string{"127.0.0.0/8"}, []byte("hmac-key"))
	if err != nil {
		t.Fatalf("new source identity: %v", err)
	}
	queue, err := NewIngressQueue(200)
	if err != nil {
		t.Fatalf("new queue: %v", err)
	}
	limiter, err := NewRateLimiter(RateLimiterConfig{
		Capacity:        200,
		RefillPerSecond: 1,
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

	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseAll := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseAll()
	started := make(chan struct{}, 101)
	body := validOTLPBody(t, "protobuf")
	responses := make(chan int, 101)
	var waitGroup sync.WaitGroup
	for range 101 {
		waitGroup.Go(func() {
			request := httptest.NewRequest(http.MethodPost, "http://example.test/v1/traces", &gatedReader{
				reader:  bytes.NewReader(body),
				started: started,
				release: release,
			})
			request.RemoteAddr = "127.0.0.1:4318"
			request.Header.Set("Authorization", "Bearer ingest-token")
			request.Header.Set("Content-Type", "application/x-protobuf")
			response := httptest.NewRecorder()
			receiver.ServeHTTP(response, request)
			responses <- response.Code
		})
	}

	for range 100 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("fewer than 100 request bodies entered the receiver")
		}
	}
	select {
	case <-started:
		t.Fatal("the 101st request entered the receiver before capacity was released")
	default:
	}
	releaseAll()
	waitGroup.Wait()
	close(responses)
	for status := range responses {
		if status != http.StatusOK {
			t.Fatalf("concurrent request status = %d, want 200", status)
		}
	}
}

type gatedReader struct {
	reader  io.Reader
	started chan<- struct{}
	release <-chan struct{}
	once    sync.Once
}

func (r *gatedReader) Read(buffer []byte) (int, error) {
	r.once.Do(func() { r.started <- struct{}{} })
	<-r.release
	return r.reader.Read(buffer)
}
