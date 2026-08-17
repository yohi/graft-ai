package ingress

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type ReceiverConfig struct {
	Authenticator         BearerAuthenticator
	SourceIdentity        SourceIdentity
	Queue                 *IngressQueue
	RateLimiter           *RateLimiter
	MaxBodyBytes          int64
	MaxConcurrentRequests int
}

type Receiver struct {
	authenticator  BearerAuthenticator
	sourceIdentity SourceIdentity
	queue          *IngressQueue
	rateLimiter    *RateLimiter
	maxBodyBytes   int64
	concurrency    chan struct{}
	metrics        *IngressMetrics
}

func NewReceiver(config ReceiverConfig) (*Receiver, error) {
	if config.Queue == nil {
		return nil, errors.New("otel ingress: queue is nil")
	}
	if config.RateLimiter == nil {
		return nil, errors.New("otel ingress: rate limiter is nil")
	}
	if config.MaxBodyBytes <= 0 {
		return nil, errors.New("otel ingress: max body size must be positive")
	}
	if config.MaxConcurrentRequests <= 0 {
		return nil, errors.New("otel ingress: max concurrent requests must be positive")
	}
	return &Receiver{
		authenticator:  config.Authenticator,
		sourceIdentity: config.SourceIdentity,
		queue:          config.Queue,
		rateLimiter:    config.RateLimiter,
		maxBodyBytes:   config.MaxBodyBytes,
		concurrency:    make(chan struct{}, config.MaxConcurrentRequests),
		metrics:        NewIngressMetrics(),
	}, nil
}

func (r *Receiver) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/v1/traces" {
		r.reject(writer, http.StatusNotFound, "path")
		return
	}
	source, err := r.sourceIdentity.Resolve(request.RemoteAddr, request.Header)
	if err != nil {
		r.reject(writer, http.StatusForbidden, "untrusted_source")
		return
	}
	if err := r.authenticator.Authenticate(request.Header); err != nil {
		r.reject(writer, http.StatusUnauthorized, "auth")
		return
	}
	if encoding := request.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		r.reject(writer, http.StatusUnsupportedMediaType, "compression")
		return
	}
	contentType, _, _ := strings.Cut(request.Header.Get("Content-Type"), ";")
	if contentType != "application/x-protobuf" && contentType != "application/json" {
		r.reject(writer, http.StatusUnsupportedMediaType, "content_type")
		return
	}
	select {
	case r.concurrency <- struct{}{}:
		defer func() { <-r.concurrency }()
	case <-request.Context().Done():
		r.reject(writer, http.StatusRequestTimeout, "timeout")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, r.maxBodyBytes))
	if err != nil {
		r.reject(writer, http.StatusRequestEntityTooLarge, "body_size")
		return
	}
	envelope, err := decodeEnvelope(body, contentType)
	if err != nil {
		r.reject(writer, http.StatusBadRequest, "parse")
		return
	}
	if allowed, retryAfter := r.rateLimiter.Allow(r.sourceIdentity.Hash(source)); !allowed {
		r.metrics.RateLimited()
		writer.Header().Set("Retry-After", retryAfterString(retryAfter))
		r.reject(writer, http.StatusTooManyRequests, "rate_limit")
		return
	}
	if !r.queue.Enqueue(envelope) {
		r.metrics.CapacityDrop()
		writer.Header().Set("X-OTel-Drop-Reason", "capacity")
		r.accept(writer, "capacity")
		return
	}
	r.metrics.Accepted()
	r.accept(writer, "accepted")
}

func (r *Receiver) Metrics() MetricsSnapshot {
	return r.metrics.Snapshot()
}

func (r *Receiver) reject(writer http.ResponseWriter, status int, reason string) {
	r.metrics.Rejected(reason)
	writeReason(writer, status, reason)
}

func (r *Receiver) accept(writer http.ResponseWriter, reason string) {
	writeReason(writer, http.StatusOK, reason)
}

func decodeEnvelope(body []byte, contentType string) (Envelope, error) {
	if len(body) == 0 {
		return Envelope{}, errors.New("otel ingress: empty OTLP payload")
	}
	payload := &collectortracepb.ExportTraceServiceRequest{}
	if contentType == "application/json" {
		if err := protojson.Unmarshal(body, payload); err != nil {
			return Envelope{}, fmt.Errorf("decode OTLP JSON: %w", err)
		}
	} else if err := proto.Unmarshal(body, payload); err != nil {
		return Envelope{}, fmt.Errorf("decode OTLP protobuf: %w", err)
	}
	for _, resource := range payload.GetResourceSpans() {
		for _, scope := range resource.GetScopeSpans() {
			for _, span := range scope.GetSpans() {
				if len(span.GetTraceId()) == 16 {
					return Envelope{
						TraceID:     hex.EncodeToString(span.GetTraceId()),
						Payload:     append([]byte(nil), body...),
						ContentType: contentType,
					}, nil
				}
			}
		}
	}
	return Envelope{}, errors.New("otel ingress: OTLP payload has no trace ID")
}

func writeReason(writer http.ResponseWriter, status int, reason string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("X-OTel-Reason", reason)
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(struct {
		Reason string `json:"reason"`
	}{Reason: reason})
}

func retryAfterString(duration time.Duration) string {
	seconds := int64(duration / time.Second)
	if duration%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(seconds, 10)
}
