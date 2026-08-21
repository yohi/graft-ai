package metrics

import (
	"encoding/json"
	"maps"
	"math"
	"strconv"
	"strings"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

const (
	RequestsMetric = "ai_gateway_requests_total"
	ErrorsMetric   = "ai_gateway_errors_total"
	DurationMetric = "ai_gateway_request_duration_seconds"
)

var DurationBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, math.Inf(1)}

type MetricSample struct {
	Name              string
	Value             float64
	Labels            map[string]string
	Kind              MetricKind
	Buckets           []float64
	BucketCounts      []uint64
	Count             uint64
	TimestampUnixNano uint64
}

type MetricKind uint8

const (
	Sum MetricKind = iota
	Gauge
)

type NormalizedMetrics struct {
	Samples []MetricSample
}

type CanonicalMetrics struct{}

func NewCanonicalMetrics() CanonicalMetrics {
	return CanonicalMetrics{}
}

func (CanonicalMetrics) Normalize(span redaction.RedactedSpan) NormalizedMetrics {
	if !isRequestSpan(span) {
		return NormalizedMetrics{}
	}
	labels := map[string]string{
		"model":       firstString(span, "model", "gen_ai.request.model"),
		"provider":    firstString(span, "provider", "gen_ai.provider.name", "gen_ai.system"),
		"status_code": firstString(span, "status_code", "http.response.status_code"),
		"env":         firstString(span, "env"),
		"gateway":     firstString(span, "gateway"),
	}
	for key, value := range labels {
		if value == "" {
			labels[key] = "unknown"
		}
	}
	duration, hasDuration := firstNumber(span, "duration_ms")
	if hasDuration {
		duration /= 1000
	} else if span.EndUnixNano >= span.StartUnixNano && span.EndUnixNano > 0 {
		duration = float64(span.EndUnixNano-span.StartUnixNano) / 1_000_000_000
	}
	timestamp := span.EndUnixNano
	if timestamp == 0 {
		timestamp = span.StartUnixNano
	}
	samples := []MetricSample{{Name: RequestsMetric, Value: 1, Labels: cloneLabels(labels), TimestampUnixNano: timestamp}}
	if isError(span) {
		samples = append(samples, MetricSample{Name: ErrorsMetric, Value: 1, Labels: cloneLabels(labels), TimestampUnixNano: timestamp})
	}
	samples = append(samples, MetricSample{
		Name:              DurationMetric,
		Value:             duration,
		Labels:            cloneLabels(labels),
		Buckets:           append([]float64(nil), DurationBuckets...),
		TimestampUnixNano: timestamp,
	})
	return NormalizedMetrics{Samples: samples}
}

func isRequestSpan(span redaction.RedactedSpan) bool {
	value, ok := span.Attributes["graft_ai.request_span"]
	if !ok {
		return false
	}
	var flag bool
	return json.Unmarshal(value, &flag) == nil && flag
}

func isError(span redaction.RedactedSpan) bool {
	status := strings.ToUpper(firstString(span, "status"))
	if status == "ERROR" {
		return true
	}
	statusCode, ok := firstNumber(span, "status_code", "http.response.status_code")
	return ok && statusCode >= 400
}

func firstString(span redaction.RedactedSpan, keys ...string) string {
	for _, key := range keys {
		value, ok := span.Attributes[key]
		if !ok {
			continue
		}
		var text string
		if json.Unmarshal(value, &text) == nil {
			if text == "" {
				continue
			}
			return text
		}
		if number, err := strconv.ParseInt(string(value), 10, 64); err == nil {
			return strconv.FormatInt(number, 10)
		}
	}
	return ""
}

func firstNumber(span redaction.RedactedSpan, keys ...string) (float64, bool) {
	for _, key := range keys {
		value, ok := span.Attributes[key]
		if !ok {
			continue
		}
		var number float64
		if json.Unmarshal(value, &number) == nil && !math.IsNaN(number) && !math.IsInf(number, 0) {
			return number, true
		}
	}
	return 0, false
}

func cloneLabels(labels map[string]string) map[string]string {
	cloned := make(map[string]string, len(labels))
	maps.Copy(cloned, labels)
	return cloned
}
