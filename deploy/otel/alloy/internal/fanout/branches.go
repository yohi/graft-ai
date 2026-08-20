package fanout

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/metrics"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/sampling"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/selector"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/spanlogs"
)

type TraceResult struct {
	Sampled bool
	Tempo   []redaction.RedactedSpan
	Loki    []spanlogs.JSONLogRecord
	Metrics metrics.NormalizedMetrics
}

type FanOut struct {
	sampler   sampling.Sampler
	metrics   metrics.CanonicalMetrics
	projector spanlogs.Projector
	sizer     spanlogs.Sizer
}

func NewFanOut(sampler sampling.Sampler) FanOut {
	return FanOut{
		sampler:   sampler,
		metrics:   metrics.NewCanonicalMetrics(),
		projector: spanlogs.NewProjector(),
		sizer:     spanlogs.NewSizer(spanlogs.MaxLineBytes),
	}
}

func (f FanOut) Trace(trace selector.Trace, ratePPM uint32) (TraceResult, error) {
	if !trace.HasRequestSpan {
		return TraceResult{}, errors.New("fanout: trace has no request span")
	}
	result := TraceResult{Metrics: f.metrics.Normalize(trace.RequestSpan)}
	sampled, err := f.sampler.DecideWithPriority(trace.TraceID, ratePPM, nil)
	if err != nil {
		return result, err
	}
	if !sampled {
		return result, nil
	}
	result.Sampled = true
	result.Tempo = make([]redaction.RedactedSpan, len(trace.Spans))
	for index, span := range trace.Spans {
		result.Tempo[index] = tempoCopy(span)
	}
	projected, _ := f.projector.ProjectRequestSpan(trace.RequestSpan)
	finalized, reason := f.sizer.Finalize(projected)
	if reason != spanlogs.DropReasonLineSizeMetadata && finalized.Serialized != nil {
		result.Loki = []spanlogs.JSONLogRecord{finalized}
	}
	return result, nil
}

func tempoCopy(span redaction.RedactedSpan) redaction.RedactedSpan {
	copy := span
	copy.Attributes = make(map[string]json.RawMessage, len(span.Attributes))
	for key, value := range span.Attributes {
		if !isTempoAttribute(key) {
			continue
		}
		copy.Attributes[key] = append(json.RawMessage(nil), value...)
	}
	copy.ResourceAttributes = make(map[string]json.RawMessage, len(span.ResourceAttributes))
	for key, value := range span.ResourceAttributes {
		if isTempoResourceAttribute(key) {
			copy.ResourceAttributes[key] = append(json.RawMessage(nil), value...)
		}
	}
	return copy
}

func isTempoAttribute(key string) bool {
	switch strings.ToLower(key) {
	case "trace_id", "span_id", "request_id", "graft_ai.request_span", "model", "provider", "status", "status_code", "gateway", "env", "input_tokens", "output_tokens", "total_tokens", "cost_usd", "duration_ms", "payload_truncated", "payload_dropped", "payload_drop_reason":
		return true
	default:
		return false
	}
}

func isTempoResourceAttribute(key string) bool {
	switch strings.ToLower(key) {
	case "service.name", "service.version", "deployment.environment", "cloud.provider", "cloud.region":
		return true
	default:
		return false
	}
}
