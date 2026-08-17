package spanlogs

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
)

const MaxLineBytes = 262144

type DropReason string

const (
	DropReasonNone                DropReason = ""
	DropReasonNumericFieldInvalid DropReason = "numeric_field_invalid"
	DropReasonLineSize            DropReason = "line_size"
	DropReasonLineSizeMetadata    DropReason = "line_size_metadata"
)

type JSONLogRecord struct {
	Fields     map[string]json.RawMessage
	Labels     map[string]string
	Serialized []byte
}

type Projector struct{}

func NewProjector() Projector {
	return Projector{}
}

func (Projector) ProjectRequestSpan(span redaction.RedactedSpan) (JSONLogRecord, DropReason) {
	record := JSONLogRecord{
		Fields: make(map[string]json.RawMessage),
		Labels: make(map[string]string),
	}
	addRaw(record.Fields, "trace_id", rawString(span.TraceID))
	addRaw(record.Fields, "span_id", rawString(span.SpanID))
	copyAttribute(record.Fields, span.Attributes, "request_id", "request_id")
	for _, field := range []string{"model", "provider", "status", "status_code", "gateway", "env"} {
		copyAttribute(record.Fields, span.Attributes, field, field)
	}
	for label := range map[string]struct{}{"model": {}, "status_code": {}, "env": {}, "gateway": {}} {
		if value, ok := attributeString(span.Attributes, label); ok && value != "" {
			record.Labels[label] = value
		}
	}

	dropReason := DropReasonNone
	for target, aliases := range numericAliases {
		value, ok := firstAttribute(span.Attributes, aliases...)
		if !ok {
			continue
		}
		number, valid := finiteNumber(value)
		if !valid {
			dropReason = DropReasonNumericFieldInvalid
			continue
		}
		record.Fields[target] = number
	}
	if _, ok := record.Fields["duration_ms"]; !ok && span.EndUnixNano >= span.StartUnixNano && span.EndUnixNano > 0 {
		duration := float64(span.EndUnixNano-span.StartUnixNano) / float64(1_000_000)
		record.Fields["duration_ms"] = rawNumber(duration)
	}
	copyPayload(record.Fields, span.Attributes, "prompt", redaction.PromptAttribute)
	copyPayload(record.Fields, span.Attributes, "completion", redaction.CompletionAttribute)
	if span.Status.PayloadDropped {
		record.Fields["payload_dropped"] = json.RawMessage("true")
		record.Fields["payload_drop_reason"] = rawString(span.Status.PayloadDropReason)
	}
	if dropReason != DropReasonNone {
		record.Fields["payload_dropped"] = json.RawMessage("true")
		record.Fields["payload_drop_reason"] = rawString(string(dropReason))
	}
	return record, dropReason
}

var numericAliases = map[string][]string{
	"input_tokens":  {"input_tokens", "gen_ai.usage.input_tokens"},
	"output_tokens": {"output_tokens", "gen_ai.usage.output_tokens"},
	"total_tokens":  {"total_tokens", "gen_ai.usage.total_tokens"},
	"cost_usd":      {"cost_usd", "gen_ai.usage.cost_usd"},
	"duration_ms":   {"duration_ms", "gen_ai.duration_ms"},
}

func copyAttribute(fields map[string]json.RawMessage, attributes map[string]json.RawMessage, target string, source string) {
	if value, ok := attributes[source]; ok {
		fields[target] = cloneRaw(value)
	}
}

func copyPayload(fields map[string]json.RawMessage, attributes map[string]json.RawMessage, target string, source string) {
	value, ok := attributes[source]
	if !ok {
		if fallback, exists := attributes[target]; exists {
			value, ok = fallback, true
		}
	}
	if !ok {
		return
	}
	fields[target] = payloadValue(value)
}

func firstAttribute(attributes map[string]json.RawMessage, keys ...string) (json.RawMessage, bool) {
	for _, key := range keys {
		if value, ok := attributes[key]; ok {
			return value, true
		}
	}
	return nil, false
}

func attributeString(attributes map[string]json.RawMessage, key string) (string, bool) {
	value, ok := attributes[key]
	if !ok {
		return "", false
	}
	var text string
	if json.Unmarshal(value, &text) == nil {
		return text, true
	}
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return "", false
	}
	return string(trimmed), true
}

func finiteNumber(value json.RawMessage) (json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 {
		return nil, false
	}
	if trimmed[0] == '"' {
		var text string
		if json.Unmarshal(trimmed, &text) != nil {
			return nil, false
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return nil, false
		}
		return rawNumber(parsed), true
	}
	if !json.Valid(trimmed) {
		return nil, false
	}
	parsed, err := strconv.ParseFloat(string(trimmed), 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return nil, false
	}
	return cloneRaw(trimmed), true
}

func payloadValue(value json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var encoded string
		if json.Unmarshal(trimmed, &encoded) == nil && json.Valid([]byte(encoded)) {
			return json.RawMessage(encoded)
		}
	}
	return cloneRaw(trimmed)
}

func rawString(value string) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}

func rawNumber(value float64) json.RawMessage {
	return json.RawMessage(strconv.FormatFloat(value, 'f', -1, 64))
}

func addRaw(fields map[string]json.RawMessage, key string, value json.RawMessage) {
	if len(value) > 0 {
		fields[key] = value
	}
}

func cloneRaw(value []byte) json.RawMessage {
	return append(json.RawMessage(nil), value...)
}
