package wire

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/spanlogs"
)

type lokiStream struct {
	Stream map[string]string `json:"stream"`
	Values [][2]string       `json:"values"`
}

type lokiPayload struct {
	Streams []lokiStream `json:"streams"`
}

var canonicalLokiLabels = []string{"model", "status_code", "env", "gateway"}

func EncodeLoki(records []spanlogs.JSONLogRecord) ([]byte, error) {
	if len(records) == 0 {
		return nil, nil
	}
	payload := lokiPayload{Streams: make([]lokiStream, 0, len(records))}
	for _, record := range records {
		if len(record.Serialized) == 0 {
			continue
		}
		timestamp := record.TimestampUnixNano
		if timestamp == 0 {
			timestamp = uint64(time.Now().UnixNano())
		}
		timestampStr := strconv.FormatUint(timestamp, 10)
		payload.Streams = append(payload.Streams, lokiStream{
			Stream: canonicalLabels(record.Labels),
			Values: [][2]string{{timestampStr, string(record.Serialized)}},
		})
	}
	if len(payload.Streams) == 0 {
		return nil, nil
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal Loki payload: %w", err)
	}
	return encoded, nil
}

func canonicalLabels(labels map[string]string) map[string]string {
	canonical := make(map[string]string, len(canonicalLokiLabels))
	for _, key := range canonicalLokiLabels {
		value := labels[key]
		if value == "" {
			value = "unknown"
		}
		canonical[key] = value
	}
	return canonical
}
