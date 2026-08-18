package ingress

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

func decodeSpan(body []byte, contentType string) (redaction.Span, error) {
	if len(body) == 0 {
		return redaction.Span{}, errors.New("otel ingress: empty OTLP payload")
	}
	payload := &collectortracepb.ExportTraceServiceRequest{}
	if contentType == "application/json" {
		if err := protojson.Unmarshal(body, payload); err != nil {
			return redaction.Span{}, fmt.Errorf("decode OTLP JSON: %w", err)
		}
	} else if err := proto.Unmarshal(body, payload); err != nil {
		return redaction.Span{}, fmt.Errorf("decode OTLP protobuf: %w", err)
	}
	for _, resource := range payload.GetResourceSpans() {
		resourceAttributes := attributeMap(resource.GetResource().GetAttributes())
		for _, scope := range resource.GetScopeSpans() {
			for _, span := range scope.GetSpans() {
				if len(span.GetTraceId()) != 16 {
					continue
				}
				return redaction.Span{
					TraceID:            hex.EncodeToString(span.GetTraceId()),
					SpanID:             hex.EncodeToString(span.GetSpanId()),
					StartUnixNano:      span.GetStartTimeUnixNano(),
					EndUnixNano:        span.GetEndTimeUnixNano(),
					Attributes:         attributeMap(span.GetAttributes()),
					ResourceAttributes: resourceAttributes,
				}, nil
			}
		}
	}
	return redaction.Span{}, errors.New("otel ingress: OTLP payload has no trace ID")
}

func attributeMap(attributes []*commonpb.KeyValue) map[string]json.RawMessage {
	result := make(map[string]json.RawMessage, len(attributes))
	for _, attribute := range attributes {
		if attribute == nil || attribute.GetKey() == "" {
			continue
		}
		result[attribute.GetKey()] = anyValueJSON(attribute.GetValue())
	}
	return result
}

func anyValueJSON(value *commonpb.AnyValue) json.RawMessage {
	if value == nil {
		return json.RawMessage("null")
	}
	switch typed := value.GetValue().(type) {
	case *commonpb.AnyValue_StringValue:
		return marshalJSONString(typed.StringValue)
	case *commonpb.AnyValue_BoolValue:
		return marshalJSONBool(typed.BoolValue)
	case *commonpb.AnyValue_IntValue:
		return json.RawMessage(strconv.FormatInt(typed.IntValue, 10))
	case *commonpb.AnyValue_DoubleValue:
		if math.IsNaN(typed.DoubleValue) || math.IsInf(typed.DoubleValue, 0) {
			return json.RawMessage("null")
		}
		return json.RawMessage(strconv.FormatFloat(typed.DoubleValue, 'g', -1, 64))
	case *commonpb.AnyValue_BytesValue:
		return marshalJSONString(base64.StdEncoding.EncodeToString(typed.BytesValue))
	case *commonpb.AnyValue_ArrayValue:
		values := make([]json.RawMessage, len(typed.ArrayValue.GetValues()))
		for index, item := range typed.ArrayValue.GetValues() {
			values[index] = anyValueJSON(item)
		}
		encoded, err := json.Marshal(values)
		if err == nil {
			return encoded
		}
	case *commonpb.AnyValue_KvlistValue:
		return marshalKeyValues(typed.KvlistValue.GetValues())
	}
	return json.RawMessage("null")
}

func marshalKeyValues(values []*commonpb.KeyValue) json.RawMessage {
	object := make(map[string]json.RawMessage, len(values))
	for _, value := range values {
		if value != nil && value.GetKey() != "" {
			object[value.GetKey()] = anyValueJSON(value.GetValue())
		}
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}

func marshalJSONString(value string) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}

func marshalJSONBool(value bool) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}
