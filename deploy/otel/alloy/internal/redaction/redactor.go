package redaction

import (
	"bytes"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
)

const (
	PromptAttribute     = "gen_ai.prompt_json"
	CompletionAttribute = "gen_ai.completion_json"
	MetadataAttribute   = "cf-aig-metadata"
)

type Span struct {
	TraceID            string
	SpanID             string
	ParentSpanID       string
	Name               string
	Kind               string
	StatusCode         string
	StatusMessage      string
	StartUnixNano      uint64
	EndUnixNano        uint64
	Attributes         map[string]json.RawMessage
	ResourceAttributes map[string]json.RawMessage
}

type RedactedSpan struct {
	Span
	Status RedactionStatus
}

type RedactionStatus struct {
	PayloadDropped    bool
	PayloadDropReason string
}

type Redactor struct{}

func NewRedactor() Redactor {
	return Redactor{}
}

func (Redactor) Redact(span Span) (RedactedSpan, RedactionStatus) {
	redacted := RedactedSpan{Span: cloneSpan(span)}
	status := RedactionStatus{}
	for key, value := range redacted.Attributes {
		if isPayloadKey(key) {
			clean, err := redactPayload(value)
			if err != nil {
				delete(redacted.Attributes, key)
				status.PayloadDropped = true
				status.PayloadDropReason = "redaction_failure"
				continue
			}
			redacted.Attributes[key] = clean
			continue
		}
		redacted.Attributes[key] = redactAttribute(key, value)
	}
	for key, value := range redacted.ResourceAttributes {
		redacted.ResourceAttributes[key] = redactAttribute(key, value)
	}
	redacted.Status = status
	return redacted, status
}

func cloneSpan(span Span) Span {
	return Span{
		TraceID:            span.TraceID,
		SpanID:             span.SpanID,
		ParentSpanID:       span.ParentSpanID,
		Name:               span.Name,
		Kind:               span.Kind,
		StatusCode:         span.StatusCode,
		StatusMessage:      span.StatusMessage,
		StartUnixNano:      span.StartUnixNano,
		EndUnixNano:        span.EndUnixNano,
		Attributes:         cloneAttributes(span.Attributes),
		ResourceAttributes: cloneAttributes(span.ResourceAttributes),
	}
}

func cloneAttributes(attributes map[string]json.RawMessage) map[string]json.RawMessage {
	cloned := make(map[string]json.RawMessage, len(attributes))
	for key, value := range attributes {
		cloned[key] = append(json.RawMessage(nil), value...)
	}
	return cloned
}

func isPayloadKey(key string) bool {
	switch strings.ToLower(key) {
	case PromptAttribute, CompletionAttribute, MetadataAttribute, "prompt", "completion":
		return true
	default:
		return false
	}
}

func isSecretKey(key string) bool {
	lower := strings.ToLower(key)
	for target, aliases := range NumericAliases {
		if lower == target {
			return false
		}
		if slices.Contains(aliases, lower) {
			return false
		}
	}
	for _, marker := range []string{"authorization", "api_key", "api-key", "apikey", "secret", "token", "password", "credential"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// NumericAliases maps canonical span-log numeric field names to the attribute
// keys that may carry their values. These keys are excluded from secret
// redaction and are projected as numbers by the span-log projector.
var NumericAliases = map[string][]string{
	"input_tokens":  {"input_tokens", "gen_ai.usage.input_tokens"},
	"output_tokens": {"output_tokens", "gen_ai.usage.output_tokens"},
	"total_tokens":  {"total_tokens", "gen_ai.usage.total_tokens"},
	"cost_usd":      {"cost_usd", "gen_ai.usage.cost_usd"},
	"duration_ms":   {"duration_ms", "gen_ai.duration_ms"},
}

func redactAttribute(key string, value json.RawMessage) json.RawMessage {
	if isSecretKey(key) {
		return json.RawMessage(`"[REDACTED]"`)
	}
	var text string
	if err := json.Unmarshal(value, &text); err == nil {
		clean := redactString(text)
		encoded, marshalErr := json.Marshal(clean)
		if marshalErr == nil {
			return encoded
		}
	}
	if first := firstByte(value); first == '{' || first == '[' {
		if clean, err := redactJSON(value); err == nil {
			return clean
		}
	}
	return append(json.RawMessage(nil), value...)
}

func redactPayload(value json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 {
		return nil, errInvalidJSON
	}
	if trimmed[0] == '"' {
		var encoded string
		if err := json.Unmarshal(trimmed, &encoded); err != nil {
			return nil, err
		}
		encodedBytes := []byte(encoded)
		if !json.Valid(bytes.TrimSpace(encodedBytes)) {
			return json.Marshal(redactString(encoded))
		}
		clean, err := redactJSON(encodedBytes)
		if err != nil {
			return nil, err
		}
		return json.Marshal(string(clean))
	}
	return redactJSON(trimmed)
}

var errInvalidJSON = &invalidJSONError{}

type invalidJSONError struct{}

func (*invalidJSONError) Error() string { return "redaction: invalid JSON" }

const maxJSONDepth = 64

func redactJSON(value []byte) (json.RawMessage, error) {
	return redactJSONAtDepth(value, 0)
}

func redactJSONAtDepth(value []byte, depth int) (json.RawMessage, error) {
	if depth > maxJSONDepth {
		return nil, errInvalidJSON
	}
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return nil, errInvalidJSON
	}
	switch trimmed[0] {
	case '{':
		var object map[string]json.RawMessage
		if err := json.Unmarshal(trimmed, &object); err != nil {
			return nil, err
		}
		clean := make(map[string]json.RawMessage, len(object))
		for key, child := range object {
			if isSecretKey(key) {
				clean[key] = json.RawMessage(`"[REDACTED]"`)
				continue
			}
			redacted, err := redactJSONAtDepth(child, depth+1)
			if err != nil {
				return nil, err
			}
			clean[key] = redacted
		}
		return json.Marshal(clean)
	case '[':
		var array []json.RawMessage
		if err := json.Unmarshal(trimmed, &array); err != nil {
			return nil, err
		}
		clean := make([]json.RawMessage, len(array))
		for index, child := range array {
			redacted, err := redactJSONAtDepth(child, depth+1)
			if err != nil {
				return nil, err
			}
			clean[index] = redacted
		}
		return json.Marshal(clean)
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return nil, err
		}
		return json.Marshal(redactString(text))
	default:
		return append(json.RawMessage(nil), trimmed...), nil
	}
}

var credentialPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`(?i)\b(?:api[_-]?key|access[_-]?token|secret|password|credential)\s*[:=]\s*[^\s,;]+`),
	regexp.MustCompile(`\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b`),
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\b(?:ghp|gho|github_pat|xox[baprs])-[A-Za-z0-9_-]+\b`),
}

func redactString(value string) string {
	clean := value
	for _, pattern := range credentialPatterns {
		clean = pattern.ReplaceAllString(clean, "[REDACTED]")
	}
	return clean
}

func firstByte(value []byte) byte {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 {
		return 0
	}
	return trimmed[0]
}
