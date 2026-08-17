package selector

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

const (
	DefaultMaxTraces = 10_000
	DefaultMaxBytes  = 64 * 1024 * 1024
	DefaultIdle      = time.Second
)

type Trace struct {
	TraceID        string
	Spans          []redaction.RedactedSpan
	RequestSpan    redaction.RedactedSpan
	HasRequestSpan bool
}

type Eviction struct {
	TraceID string
	Reason  string
}

type RequestSelector struct {
	maxTraces int
	maxBytes  int64
	idle      time.Duration
	traces    map[string]*traceState
	bytes     int64
}

type traceState struct {
	traceID      string
	spans        []redaction.RedactedSpan
	lastReceived time.Time
	bytes        int64
}

func NewRequestSelector(maxTraces int, maxBytes int64, idle time.Duration) (*RequestSelector, error) {
	if maxTraces <= 0 || maxBytes <= 0 || idle <= 0 {
		return nil, errors.New("selector: limits and idle duration must be positive")
	}
	return &RequestSelector{
		maxTraces: maxTraces,
		maxBytes:  maxBytes,
		idle:      idle,
		traces:    make(map[string]*traceState),
	}, nil
}

func NewDefaultRequestSelector() *RequestSelector {
	selector, _ := NewRequestSelector(DefaultMaxTraces, DefaultMaxBytes, DefaultIdle)
	return selector
}

func (s *RequestSelector) Add(span redaction.RedactedSpan) []Eviction {
	return s.AddAt(span, time.Now())
}

func (s *RequestSelector) AddAt(span redaction.RedactedSpan, receivedAt time.Time) []Eviction {
	if span.TraceID == "" {
		return nil
	}
	state := s.traces[span.TraceID]
	if state == nil {
		state = &traceState{traceID: span.TraceID}
		s.traces[span.TraceID] = state
	}
	cloned := cloneSpan(span)
	state.spans = append(state.spans, cloned)
	state.lastReceived = receivedAt
	state.bytes += spanSize(cloned)
	s.bytes += spanSize(cloned)
	return s.Evict()
}

func (s *RequestSelector) FlushIdle(now time.Time) []Trace {
	keys := make([]string, 0, len(s.traces))
	for traceID, state := range s.traces {
		if now.Sub(state.lastReceived) >= s.idle {
			keys = append(keys, traceID)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		left, right := s.traces[keys[i]], s.traces[keys[j]]
		if left.lastReceived.Equal(right.lastReceived) {
			return left.traceID < right.traceID
		}
		return left.lastReceived.Before(right.lastReceived)
	})
	flushed := make([]Trace, 0, len(keys))
	for _, traceID := range keys {
		state := s.traces[traceID]
		delete(s.traces, traceID)
		s.bytes -= state.bytes
		flushed = append(flushed, buildTrace(*state))
	}
	return flushed
}

func (s *RequestSelector) Evict() []Eviction {
	var evictions []Eviction
	for len(s.traces) > s.maxTraces || s.bytes > s.maxBytes {
		oldestID := ""
		for traceID, state := range s.traces {
			if oldestID == "" || before(state, s.traces[oldestID]) {
				oldestID = traceID
			}
		}
		state := s.traces[oldestID]
		delete(s.traces, oldestID)
		s.bytes -= state.bytes
		evictions = append(evictions, Eviction{TraceID: oldestID, Reason: "trace_state_evicted"})
	}
	return evictions
}

func (s *RequestSelector) Len() int { return len(s.traces) }

func (s *RequestSelector) Bytes() int64 { return s.bytes }

func before(left, right *traceState) bool {
	if left.lastReceived.Equal(right.lastReceived) {
		return left.traceID < right.traceID
	}
	return left.lastReceived.Before(right.lastReceived)
}

func buildTrace(state traceState) Trace {
	spans := make([]redaction.RedactedSpan, len(state.spans))
	for index, span := range state.spans {
		spans[index] = cloneSpan(span)
		if spans[index].Attributes == nil {
			spans[index].Attributes = make(map[string]json.RawMessage)
		}
		spans[index].Attributes["graft_ai.request_span"] = json.RawMessage("false")
	}
	selected := requestSpanIndex(spans)
	trace := Trace{TraceID: state.traceID, Spans: spans}
	if selected < 0 {
		return trace
	}
	trace.Spans[selected].Attributes["graft_ai.request_span"] = json.RawMessage("true")
	trace.RequestSpan = cloneSpan(trace.Spans[selected])
	trace.HasRequestSpan = true
	return trace
}

func requestSpanIndex(spans []redaction.RedactedSpan) int {
	selected := -1
	for index, span := range spans {
		if !isRequestCandidate(span) {
			continue
		}
		if selected < 0 || spanBefore(span, spans[selected]) {
			selected = index
		}
	}
	return selected
}

func isRequestCandidate(span redaction.RedactedSpan) bool {
	if attributeString(span, "span.kind") != "server" {
		return false
	}
	parent := attributeString(span, "parent_span_id")
	requestID := attributeString(span, "request_id")
	if parent == "" || requestID != "" {
		return true
	}
	return false
}

func spanBefore(left, right redaction.RedactedSpan) bool {
	if left.StartUnixNano != right.StartUnixNano {
		return left.StartUnixNano < right.StartUnixNano
	}
	return left.SpanID < right.SpanID
}

func attributeString(span redaction.RedactedSpan, key string) string {
	value, ok := span.Attributes[key]
	if !ok {
		return ""
	}
	var text string
	if json.Unmarshal(value, &text) == nil {
		return strings.ToLower(text)
	}
	return ""
}

func spanSize(span redaction.RedactedSpan) int64 {
	size := int64(len(span.TraceID) + len(span.SpanID))
	for key, value := range span.Attributes {
		size += int64(len(key) + len(value))
	}
	for key, value := range span.ResourceAttributes {
		size += int64(len(key) + len(value))
	}
	return size
}

func cloneSpan(span redaction.RedactedSpan) redaction.RedactedSpan {
	attributes := make(map[string]json.RawMessage, len(span.Attributes))
	for key, value := range span.Attributes {
		attributes[key] = append(json.RawMessage(nil), value...)
	}
	resources := make(map[string]json.RawMessage, len(span.ResourceAttributes))
	for key, value := range span.ResourceAttributes {
		resources[key] = append(json.RawMessage(nil), value...)
	}
	span.Attributes = attributes
	span.ResourceAttributes = resources
	return span
}
