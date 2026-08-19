package wire

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

func EncodeTempo(spans []redaction.RedactedSpan) ([]byte, error) {
	if len(spans) == 0 {
		return nil, nil
	}
	groupKeys := make([]string, len(spans))
	groupCounts := make(map[string]int)
	for index, span := range spans {
		key := resourceAttributesKey(span.ResourceAttributes)
		groupKeys[index] = key
		groupCounts[key]++
	}
	resourceSpansByAttributes := make(map[string]*tracepb.ResourceSpans)
	for index, span := range spans {
		key := groupKeys[index]
		group, ok := resourceSpansByAttributes[key]
		if !ok {
			resourceAttributes, err := attributesProto(span.ResourceAttributes)
			if err != nil {
				return nil, err
			}
			group = &tracepb.ResourceSpans{
				Resource: &resourcepb.Resource{Attributes: resourceAttributes},
				ScopeSpans: []*tracepb.ScopeSpans{{
					Spans: make([]*tracepb.Span, 0, groupCounts[key]),
				}},
			}
			resourceSpansByAttributes[key] = group
		}
		encoded, err := spanProto(span)
		if err != nil {
			return nil, fmt.Errorf("encode Tempo span: %w", err)
		}
		group.ScopeSpans[0].Spans = append(group.ScopeSpans[0].Spans, encoded)
	}
	keys := make([]string, 0, len(resourceSpansByAttributes))
	for key := range resourceSpansByAttributes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	resourceSpans := make([]*tracepb.ResourceSpans, 0, len(resourceSpansByAttributes))
	for _, key := range keys {
		resourceSpans = append(resourceSpans, resourceSpansByAttributes[key])
	}
	payload, err := proto.Marshal(&collectortracepb.ExportTraceServiceRequest{ResourceSpans: resourceSpans})
	if err != nil {
		return nil, fmt.Errorf("marshal Tempo payload: %w", err)
	}
	return payload, nil
}

func resourceAttributesKey(attributes map[string]json.RawMessage) string {
	keys := make([]string, 0, len(attributes))
	for key := range attributes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var builder strings.Builder
	for _, key := range keys {
		builder.WriteString(key)
		builder.WriteByte(0)
		builder.Write(attributes[key])
		builder.WriteByte(0)
	}
	return builder.String()
}

func spanProto(span redaction.RedactedSpan) (*tracepb.Span, error) {
	traceID, err := decodeHexID(span.TraceID, 16)
	if err != nil {
		return nil, fmt.Errorf("trace ID: %w", err)
	}
	spanID, err := decodeHexID(span.SpanID, 8)
	if err != nil {
		return nil, fmt.Errorf("span ID: %w", err)
	}
	parentID, err := decodeOptionalHexID(span.ParentSpanID, 8)
	if err != nil {
		return nil, fmt.Errorf("parent span ID: %w", err)
	}
	attributes, err := attributesProto(span.Attributes)
	if err != nil {
		return nil, err
	}
	return &tracepb.Span{
		TraceId:           traceID,
		SpanId:            spanID,
		ParentSpanId:      parentID,
		Name:              span.Name,
		Kind:              spanKindProto(span.Kind),
		StartTimeUnixNano: span.StartUnixNano,
		EndTimeUnixNano:   span.EndUnixNano,
		Attributes:        attributes,
		Status: &tracepb.Status{
			Code:    spanStatusProto(span.StatusCode),
			Message: span.StatusMessage,
		},
	}, nil
}

func decodeHexID(value string, size int) ([]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != size {
		return nil, fmt.Errorf("invalid hexadecimal ID")
	}
	return decoded, nil
}

func decodeOptionalHexID(value string, size int) ([]byte, error) {
	if value == "" {
		return nil, nil
	}
	return decodeHexID(value, size)
}

func spanKindProto(kind string) tracepb.Span_SpanKind {
	switch strings.ToLower(kind) {
	case "internal":
		return tracepb.Span_SPAN_KIND_INTERNAL
	case "server":
		return tracepb.Span_SPAN_KIND_SERVER
	case "client":
		return tracepb.Span_SPAN_KIND_CLIENT
	case "producer":
		return tracepb.Span_SPAN_KIND_PRODUCER
	case "consumer":
		return tracepb.Span_SPAN_KIND_CONSUMER
	default:
		return tracepb.Span_SPAN_KIND_UNSPECIFIED
	}
}

func spanStatusProto(status string) tracepb.Status_StatusCode {
	switch strings.ToUpper(status) {
	case "OK":
		return tracepb.Status_STATUS_CODE_OK
	case "ERROR":
		return tracepb.Status_STATUS_CODE_ERROR
	default:
		return tracepb.Status_STATUS_CODE_UNSET
	}
}

func attributesProto(attributes map[string]json.RawMessage) ([]*commonpb.KeyValue, error) {
	keys := make([]string, 0, len(attributes))
	for key := range attributes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]*commonpb.KeyValue, 0, len(keys))
	for _, key := range keys {
		value, err := anyValueProto(attributes[key])
		if err != nil {
			return nil, fmt.Errorf("attribute %q: %w", key, err)
		}
		result = append(result, &commonpb.KeyValue{Key: key, Value: value})
	}
	return result, nil
}

func anyValueProto(raw json.RawMessage) (*commonpb.AnyValue, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return &commonpb.AnyValue{}, nil
	}
	if strings.HasPrefix(trimmed, `"`) {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, fmt.Errorf("string value: %w", err)
		}
		return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}}, nil
	}
	if trimmed == "true" || trimmed == "false" {
		return &commonpb.AnyValue{Value: &commonpb.AnyValue_BoolValue{BoolValue: trimmed == "true"}}, nil
	}
	if strings.HasPrefix(trimmed, "{") {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil {
			return nil, fmt.Errorf("object value: %w", err)
		}
		keys := make([]string, 0, len(object))
		for key := range object {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		values := make([]*commonpb.KeyValue, 0, len(keys))
		for _, key := range keys {
			value, err := anyValueProto(object[key])
			if err != nil {
				return nil, fmt.Errorf("object field %q: %w", key, err)
			}
			values = append(values, &commonpb.KeyValue{Key: key, Value: value})
		}
		return &commonpb.AnyValue{Value: &commonpb.AnyValue_KvlistValue{KvlistValue: &commonpb.KeyValueList{Values: values}}}, nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var values []json.RawMessage
		if err := json.Unmarshal(raw, &values); err != nil {
			return nil, fmt.Errorf("array value: %w", err)
		}
		items := make([]*commonpb.AnyValue, 0, len(values))
		for _, value := range values {
			item, err := anyValueProto(value)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		return &commonpb.AnyValue{Value: &commonpb.AnyValue_ArrayValue{ArrayValue: &commonpb.ArrayValue{Values: items}}}, nil
	}
	if integer, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		return &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: integer}}, nil
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return nil, fmt.Errorf("number value: %w", err)
	}
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: value}}, nil
}
