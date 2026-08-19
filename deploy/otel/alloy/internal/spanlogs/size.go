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

	var promptRoot, completionRoot *jsonNode
	if hasPrompt {
		promptRoot, err = decodeNode(originalPrompt)
		if err != nil {
			return dropPayload(finalized, metadata, maxBytes)
		}
		promptRoot.prepareForTruncation()
	}
	if hasCompletion {
		completionRoot, err = decodeNode(originalCompletion)
		if err != nil {
			return dropPayload(finalized, metadata, maxBytes)
		}
		completionRoot.prepareForTruncation()
	}

	var promptTarget, completionTarget int
	switch payloadCount {
	case 1:
		if hasPrompt {
			promptTarget = remaining
		} else {
			completionTarget = remaining
		}
	case 2:
		promptTarget = remaining / 2
		completionTarget = remaining - promptTarget
	}
	if promptTarget < 0 {
		promptTarget = 0
	}
	if completionTarget < 0 {
		completionTarget = 0
	}

	for range 3 {
		candidate := cloneFields(metadata)
		if hasPrompt {
			candidate["prompt"], _ = promptRoot.truncate(promptTarget)
		}
		if hasCompletion {
			candidate["completion"], _ = completionRoot.truncate(completionTarget)
		}
		serialized, err = marshalFields(candidate)
		if err == nil && len(serialized) <= maxBytes {
			finalized.Fields = candidate
			finalized.Serialized = serialized
			return finalized, DropReasonNone
		}
		if err != nil {
			break
		}
		over := len(serialized) - maxBytes
		if promptTarget+completionTarget <= over+1 {
			break
		}
		if hasPrompt && hasCompletion {
			promptOver := (over + 1) / 2
			completionOver := over + 1 - promptOver
			promptTarget -= promptOver
			completionTarget -= completionOver
		} else if hasPrompt {
			promptTarget -= over + 1
		} else if hasCompletion {
			completionTarget -= over + 1
		}
	}
	return dropPayload(finalized, metadata, maxBytes)
}

func dropPayload(record JSONLogRecord, metadata map[string]json.RawMessage, maxBytes int) (JSONLogRecord, DropReason) {
	delete(metadata, "payload_truncated")
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
		Fields:            cloneFields(record.Fields),
		Labels:            cloneLabels(record.Labels),
		TimestampUnixNano: record.TimestampUnixNano,
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
	kind        byte
	object      map[string]*jsonNode
	array       []*jsonNode
	text        string
	scalar      json.RawMessage
	encodedSize int
	strings     []*jsonNode
	parent      *jsonNode
}

const truncatedSuffix = "[TRUNCATED]"

func TruncatedSuffix() string {
	return truncatedSuffix
}

func (n *jsonNode) prepareForTruncation() {
	n.strings = n.stringNodes()
	if len(n.strings) > 1 {
		sort.Slice(n.strings, func(i, j int) bool {
			return utf8.RuneCountInString(n.strings[i].text) > utf8.RuneCountInString(n.strings[j].text)
		})
	}
	n.refreshEncodedSize()
}

func (n *jsonNode) refreshEncodedSize() {
	switch n.kind {
	case '{':
		size := 2 // {}
		first := true
		for key, child := range n.object {
			child.refreshEncodedSize()
			if !first {
				size++ // comma
			}
			first = false
			size += jsonStringByteSize(key) + 1 + child.encodedSize
		}
		n.encodedSize = size
	case '[':
		size := 2 // []
		first := true
		for _, child := range n.array {
			child.refreshEncodedSize()
			if !first {
				size++ // comma
			}
			first = false
			size += child.encodedSize
		}
		n.encodedSize = size
	case '"':
		n.encodedSize = jsonStringByteSize(n.text)
	default:
		n.encodedSize = len(n.scalar)
	}
}

func (n *jsonNode) applySizeDelta(delta int) {
	for node := n; node != nil; node = node.parent {
		node.encodedSize += delta
	}
}

func (n *jsonNode) truncate(maxBytes int) (json.RawMessage, bool) {
	if n.encodedSize <= maxBytes {
		return n.marshal(), false
	}
	if len(n.strings) == 0 {
		return n.marshal(), false
	}
	truncated := false
	suffixBytes := jsonStringByteSize(truncatedSuffix)
	for _, node := range n.strings {
		if n.encodedSize <= maxBytes {
			break
		}
		over := n.encodedSize - maxBytes
		currentBytes := node.encodedSize
		targetBytes := currentBytes - over - 1
		targetBytes = max(targetBytes, suffixBytes)
		clean, changed := truncateString(node.text, targetBytes)
		if !changed {
			continue
		}
		newSize := jsonStringByteSize(clean)
		node.applySizeDelta(newSize - node.encodedSize)
		node.encodedSize = newSize
		node.text = clean
		truncated = true
	}
	return n.marshal(), truncated
}

const maxJSONDepth = 64

func decodeNode(value []byte) (*jsonNode, error) {
	return decodeNodeAtDepth(value, 0)
}

func decodeNodeAtDepth(value []byte, depth int) (*jsonNode, error) {
	if depth > maxJSONDepth {
		return nil, errInvalidNode
	}
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
			decoded, err := decodeNodeAtDepth(child, depth+1)
			if err != nil {
				return nil, err
			}
			decoded.parent = node
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
			decoded, err := decodeNodeAtDepth(child, depth+1)
			if err != nil {
				return nil, err
			}
			decoded.parent = node
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
	if jsonStringByteSize(value) <= maxBytes {
		return value, false
	}
	runes := []rune(value)
	best := ""
	low, high := 0, len(runes)
	for low <= high {
		middle := low + (high-low)/2
		candidate := string(runes[:middle]) + truncatedSuffix
		if jsonStringByteSize(candidate) <= maxBytes {
			best = candidate
			low = middle + 1
		} else {
			high = middle - 1
		}
	}
	return best, true
}

func jsonStringByteSize(value string) int {
	size := 2 // surrounding quotes
	for _, r := range value {
		switch r {
		case '"', '\\', '\b', '\f', '\n', '\r', '\t':
			size += 2
		case '<', '>', '&':
			size += 6 // \u003c, \u003e, \u0026
		case '\u2028', '\u2029':
			size += 6 // \u2028, \u2029
		default:
			if r < 0x20 {
				size += 6 // \u00XX
			} else {
				size += utf8.RuneLen(r)
			}
		}
	}
	return size
}

func marshalString(value string) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}
