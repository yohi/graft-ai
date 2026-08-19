package ingress

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

const (
	contentTypeProtobuf = "application/x-protobuf"
	contentTypeJSON     = "application/json"
)

type ReceiverConfig struct {
	Authenticator         BearerAuthenticator
	SourceIdentity        SourceIdentity
	Queue                 *IngressQueue
	RateLimiter           *RateLimiter
	MaxBodyBytes          int64
	MaxConcurrentRequests int
	SamplingRatePPM       uint32
	Now                   func() time.Time
}

type Receiver struct {
	authenticator   BearerAuthenticator
	sourceIdentity  SourceIdentity
	queue           *IngressQueue
	rateLimiter     *RateLimiter
	maxBodyBytes    int64
	samplingRatePPM uint32
	concurrency     chan struct{}
	metrics         *IngressMetrics
	redactor        redaction.Redactor
	now             func() time.Time
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
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &Receiver{
		authenticator:   config.Authenticator,
		sourceIdentity:  config.SourceIdentity,
		queue:           config.Queue,
		rateLimiter:     config.RateLimiter,
		maxBodyBytes:    config.MaxBodyBytes,
		samplingRatePPM: config.SamplingRatePPM,
		concurrency:     make(chan struct{}, config.MaxConcurrentRequests),
		metrics:         NewIngressMetrics(),
		redactor:        redaction.NewRedactor(),
		now:             now,
	}, nil
}

func (r *Receiver) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/v1/traces" {
		r.reject(writer, http.StatusNotFound, "path")
		return
	}
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		r.reject(writer, http.StatusMethodNotAllowed, "method")
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
	contentType = strings.TrimSpace(contentType)
	if contentType != contentTypeProtobuf && contentType != contentTypeJSON {
		r.reject(writer, http.StatusUnsupportedMediaType, "content_type")
		return
	}
	if allowed, retryAfter := r.rateLimiter.Allow(r.sourceIdentity.Hash(source)); !allowed {
		r.metrics.RateLimited()
		writer.Header().Set("Retry-After", retryAfterString(retryAfter))
		r.reject(writer, http.StatusTooManyRequests, "rate_limit")
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
		if isBodyTimeout(request, err) {
			r.reject(writer, http.StatusRequestTimeout, "timeout")
		} else {
			r.reject(writer, http.StatusRequestEntityTooLarge, "body_size")
		}
		return
	}
	spans, err := decodeSpans(body, contentType)
	if err != nil {
		r.reject(writer, http.StatusBadRequest, "parse")
		return
	}

	var accepted int
	for _, span := range spans {
		redacted, _ := r.redactor.Redact(span)
		payload, marshalErr := json.Marshal(redacted.Attributes)
		if marshalErr != nil {
			payload = []byte("{}")
		}
		envelope := Envelope{
			TraceID:         redacted.TraceID,
			Payload:         payload,
			ContentType:     "application/json",
			SamplingRatePPM: r.samplingRatePPM,
			Span:            redacted,
			ReceivedAt:      r.now(),
		}
		if !r.queue.Enqueue(envelope) {
			r.metrics.CapacityDrop()
			if accepted > 0 {
				r.metrics.AcceptedN(accepted)
			}
			writer.Header().Set("X-OTel-Drop-Reason", "capacity")
			r.accept(writer, "capacity")
			return
		}
		accepted++
	}
	if accepted == 0 {
		r.accept(writer, "accepted")
		return
	}
	r.metrics.AcceptedN(accepted)
	r.accept(writer, "accepted")
}

func isBodyTimeout(request *http.Request, err error) bool {
	if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(request.Context().Err(), context.DeadlineExceeded) {
		return true
	}
	var networkError net.Error
	return errors.As(err, &networkError) && networkError.Timeout()
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
