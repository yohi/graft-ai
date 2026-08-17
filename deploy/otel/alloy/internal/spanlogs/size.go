package spanlogs

import (
	"bytes"
	"encoding/json"
	"maps"
	"sort"
	"unicode/utf8"
)

type Sizer struct {
	maxBytes int
}

func NewSizer(maxBytes int) Sizer {
	if maxBytes <= 0 {
		maxBytes = MaxLineBytes
	}
	return Sizer{maxBytes: maxBytes}
}

func (s Sizer) Finalize(record JSONLogRecord) (JSONLogRecord, DropReason) {
	maxBytes := s.maxBytes
	finalized := cloneRecord(record)
	serialized, err := marshalFields(finalized.Fields)
	if err != nil {
		return finalized, DropReasonLineSizeMetadata
	}
	if len(serialized) <= maxBytes {
		finalized.Serialized = serialized
		return finalized, DropReasonNone
	}

	originalPrompt, hasPrompt := finalized.Fields["prompt"]
	originalCompletion, hasCompletion := finalized.Fields["completion"]
	metadata := cloneFields(finalized.Fields)
	delete(metadata, "prompt")
	delete(metadata, "completion")
	metadata["payload_truncated"] = json.RawMessage("true")
	base := cloneFields(metadata)
	if hasPrompt {
		base["prompt"] = json.RawMessage(`""`)
	}
	if hasCompletion {
		base["completion"] = json.RawMessage(`""`)
	}
	baseSerialized, err := marshalFields(base)
	if err != nil || len(baseSerialized) > maxBytes {
		return dropPayload(finalized, metadata, maxBytes)
	}

	payloadCount := 0
	if hasPrompt {
		payloadCount++
	}
	if hasCompletion {
		payloadCount++
	}
	if payloadCount == 0 {
		return dropPayload(finalized, metadata, maxBytes)
	}
	remaining := maxBytes - len(baseSerialized)
	target := remaining / payloadCount
	for range 32 {
		candidate := cloneFields(metadata)
		if hasPrompt {
			candidate["prompt"], _ = truncateJSON(originalPrompt, target)
		}
		if hasCompletion {
			candidate["completion"], _ = truncateJSON(originalCompletion, target)
		}
		serialized, err = marshalFields(candidate)
		if err == nil && len(serialized) <= maxBytes {
			finalized.Fields = candidate
			finalized.Serialized = serialized
			return finalized, DropReasonNone
		}
		over := 1
		if err == nil {
			over = len(serialized) - maxBytes + 1
		}
		if target <= over {
			break
		}
		target -= over
	}
	return dropPayload(finalized, metadata, maxBytes)
}

func dropPayload(record JSONLogRecord, metadata map[string]json.RawMessage, maxBytes int) (JSONLogRecord, DropReason) {
	metadata["payload_dropped"] = json.RawMessage("true")
	metadata["payload_drop_reason"] = json.RawMessage(`"line_size"`)
	serialized, err := marshalFields(metadata)
	if err == nil && len(serialized) <= maxBytes {
		record.Fields = metadata
		record.Serialized = serialized
		return record, DropReasonLineSize
	}
	record.Fields = metadata
	record.Serialized = nil
	return record, DropReasonLineSizeMetadata
}

func cloneRecord(record JSONLogRecord) JSONLogRecord {
	return JSONLogRecord{
		Fields: cloneFields(record.Fields),
		Labels: cloneLabels(record.Labels),
	}
}

func cloneFields(fields map[string]json.RawMessage) map[string]json.RawMessage {
	cloned := make(map[string]json.RawMessage, len(fields))
	for key, value := range fields {
		cloned[key] = append(json.RawMessage(nil), value...)
	}
	return cloned
}

func cloneLabels(labels map[string]string) map[string]string {
	cloned := make(map[string]string, len(labels))
	maps.Copy(cloned, labels)
	return cloned
}

func marshalFields(fields map[string]json.RawMessage) ([]byte, error) {
	return json.Marshal(fields)
}

type jsonNode struct {
	kind   byte
	object map[string]*jsonNode
	array  []*jsonNode
	text   string
	scalar json.RawMessage
}

func truncateJSON(value json.RawMessage, maxBytes int) (json.RawMessage, bool) {
	node, err := decodeNode(value)
	if err != nil {
		return cloneRaw(value), false
	}
	encoded := node.marshal()
	if len(encoded) <= maxBytes {
		return encoded, false
	}
	truncated := false
	for len(encoded) > maxBytes {
		stringsNodes := node.stringNodes()
		if len(stringsNodes) == 0 {
			break
		}
		sort.Slice(stringsNodes, func(i, j int) bool {
			return utf8.RuneCountInString(stringsNodes[i].text) > utf8.RuneCountInString(stringsNodes[j].text)
		})
		longest := stringsNodes[0]
		over := len(encoded) - maxBytes
		currentBytes := len(marshalString(longest.text))
		targetBytes := currentBytes - over - 1
		if targetBytes < len(marshalString("[TRUNCATED]")) {
			targetBytes = len(marshalString("[TRUNCATED]"))
		}
		clean, changed := truncateString(longest.text, targetBytes)
		if !changed {
			break
		}
		longest.text = clean
		truncated = true
		encoded = node.marshal()
	}
	return encoded, truncated
}

func decodeNode(value []byte) (*jsonNode, error) {
	trimmed := bytes.TrimSpace(value)
	if !json.Valid(trimmed) || len(trimmed) == 0 {
		return nil, errInvalidNode
	}
	switch trimmed[0] {
	case '{':
		var object map[string]json.RawMessage
		if err := json.Unmarshal(trimmed, &object); err != nil {
			return nil, err
		}
		node := &jsonNode{kind: '{', object: make(map[string]*jsonNode, len(object))}
		for key, child := range object {
			decoded, err := decodeNode(child)
			if err != nil {
				return nil, err
			}
			node.object[key] = decoded
		}
		return node, nil
	case '[':
		var array []json.RawMessage
		if err := json.Unmarshal(trimmed, &array); err != nil {
			return nil, err
		}
		node := &jsonNode{kind: '[', array: make([]*jsonNode, len(array))}
		for index, child := range array {
			decoded, err := decodeNode(child)
			if err != nil {
				return nil, err
			}
			node.array[index] = decoded
		}
		return node, nil
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return nil, err
		}
		return &jsonNode{kind: '"', text: text}, nil
	default:
		return &jsonNode{kind: 's', scalar: append(json.RawMessage(nil), trimmed...)}, nil
	}
}

var errInvalidNode = &invalidNodeError{}

type invalidNodeError struct{}

func (*invalidNodeError) Error() string { return "spanlogs: invalid JSON node" }

func (n *jsonNode) marshal() []byte {
	switch n.kind {
	case '{':
		object := make(map[string]json.RawMessage, len(n.object))
		for key, child := range n.object {
			object[key] = child.marshal()
		}
		encoded, _ := json.Marshal(object)
		return encoded
	case '[':
		array := make([]json.RawMessage, len(n.array))
		for index, child := range n.array {
			array[index] = child.marshal()
		}
		encoded, _ := json.Marshal(array)
		return encoded
	case '"':
		return marshalString(n.text)
	default:
		return n.scalar
	}
}

func (n *jsonNode) stringNodes() []*jsonNode {
	if n.kind == '"' {
		return []*jsonNode{n}
	}
	var nodes []*jsonNode
	if n.kind == '{' {
		for _, child := range n.object {
			nodes = append(nodes, child.stringNodes()...)
		}
	}
	if n.kind == '[' {
		for _, child := range n.array {
			nodes = append(nodes, child.stringNodes()...)
		}
	}
	return nodes
}

func truncateString(value string, maxBytes int) (string, bool) {
	if len(marshalString(value)) <= maxBytes {
		return value, false
	}
	suffix := "[TRUNCATED]"
	runes := []rune(value)
	best := ""
	low, high := 0, len(runes)
	for low <= high {
		middle := low + (high-low)/2
		candidate := string(runes[:middle]) + suffix
		if len(marshalString(candidate)) <= maxBytes {
			best = candidate
			low = middle + 1
		} else {
			high = middle - 1
		}
	}
	return best, true
}

func marshalString(value string) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}
