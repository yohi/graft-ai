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
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

func decodeSpans(body []byte, contentType string) ([]redaction.Span, error) {
	if len(body) == 0 {
		return nil, errors.New("otel ingress: empty OTLP payload")
	}
	payload := &collectortracepb.ExportTraceServiceRequest{}
	if contentType == "application/json" {
		if err := protojson.Unmarshal(body, payload); err != nil {
			return nil, fmt.Errorf("decode OTLP JSON: %w", err)
		}
	} else if err := proto.Unmarshal(body, payload); err != nil {
		return nil, fmt.Errorf("decode OTLP protobuf: %w", err)
	}

	var spans []redaction.Span
	for _, resource := range payload.GetResourceSpans() {
		resourceAttributes := attributeMap(resource.GetResource().GetAttributes())
		for _, scope := range resource.GetScopeSpans() {
			for _, span := range scope.GetSpans() {
				if len(span.GetTraceId()) != 16 {
					continue
				}
				if len(span.GetSpanId()) != 8 {
					continue
				}
				attributes := attributeMap(span.GetAttributes())
				normalizeAttributes(attributes, span)
				parentSpanID := hex.EncodeToString(span.GetParentSpanId())
				spans = append(spans, redaction.Span{
					TraceID:            hex.EncodeToString(span.GetTraceId()),
					SpanID:             hex.EncodeToString(span.GetSpanId()),
					ParentSpanID:       parentSpanID,
					Name:               span.GetName(),
					Kind:               spanKindName(span.GetKind()),
					StatusCode:         spanStatusName(span.GetStatus().GetCode()),
					StatusMessage:      span.GetStatus().GetMessage(),
					StartUnixNano:      span.GetStartTimeUnixNano(),
					EndUnixNano:        span.GetEndTimeUnixNano(),
					Attributes:         attributes,
					ResourceAttributes: resourceAttributes,
				})
			}
		}
	}
	if len(spans) == 0 {
		return nil, errors.New("otel ingress: OTLP payload has no trace ID")
	}
	return spans, nil
}

func normalizeAttributes(attributes map[string]json.RawMessage, span *tracepb.Span) {
	if _, ok := attributes["span.kind"]; !ok {
		attributes["span.kind"] = marshalJSONString(spanKindName(span.GetKind()))
	}
	if _, ok := attributes["parent_span_id"]; !ok {
		attributes["parent_span_id"] = marshalJSONString(hex.EncodeToString(span.GetParentSpanId()))
	}
	if status := spanStatusName(span.GetStatus().GetCode()); status != "" {
		if _, ok := attributes["status"]; !ok {
			attributes["status"] = marshalJSONString(status)
		}
	}
	for _, alias := range []struct {
		canonical string
		aliases   []string
	}{
		{canonical: "model", aliases: []string{"gen_ai.request.model"}},
		{canonical: "provider", aliases: []string{"gen_ai.provider.name", "gen_ai.system"}},
		{canonical: "request_id", aliases: []string{"cf-aig-request-id", "cf_aig_request_id"}},
		{canonical: "env", aliases: []string{"deployment.environment", "deployment.environment.name"}},
		{canonical: "gateway", aliases: []string{"cf-aig-gateway", "ai_gateway.name"}},
		{canonical: "input_tokens", aliases: []string{"gen_ai.usage.input_tokens"}},
		{canonical: "output_tokens", aliases: []string{"gen_ai.usage.output_tokens"}},
		{canonical: "total_tokens", aliases: []string{"gen_ai.usage.total_tokens"}},
		{canonical: "cost_usd", aliases: []string{"gen_ai.usage.cost", "gen_ai.usage.cost_usd"}},
		{canonical: "status_code", aliases: []string{"http.response.status_code"}},
	} {
		if _, ok := attributes[alias.canonical]; ok {
			continue
		}
		for _, key := range alias.aliases {
			if value, ok := attributes[key]; ok {
				attributes[alias.canonical] = append(json.RawMessage(nil), value...)
				break
			}
		}
	}
}

func spanKindName(kind tracepb.Span_SpanKind) string {
	switch kind {
	case tracepb.Span_SPAN_KIND_INTERNAL:
		return "internal"
	case tracepb.Span_SPAN_KIND_SERVER:
		return "server"
	case tracepb.Span_SPAN_KIND_CLIENT:
		return "client"
	case tracepb.Span_SPAN_KIND_PRODUCER:
		return "producer"
	case tracepb.Span_SPAN_KIND_CONSUMER:
		return "consumer"
	default:
		return "unspecified"
	}
}

func spanStatusName(status tracepb.Status_StatusCode) string {
	switch status {
	case tracepb.Status_STATUS_CODE_OK:
		return "OK"
	case tracepb.Status_STATUS_CODE_ERROR:
		return "ERROR"
	default:
		return "UNSET"
	}
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
		v := typed.DoubleValue
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return json.RawMessage("null")
		}
		return json.RawMessage(strconv.FormatFloat(v, 'g', -1, 64))
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
