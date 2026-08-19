package wire

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/spanlogs"
)

type lokiStream struct {
	Stream map[string]string `json:"stream"`
	Values [][2]string       `json:"values"`
}

type lokiPayload struct {
	Streams []lokiStream `json:"streams"`
}

func EncodeLoki(records []spanlogs.JSONLogRecord) ([]byte, error) {
	if len(records) == 0 {
		return nil, nil
	}
	payload := lokiPayload{Streams: make([]lokiStream, 0, len(records))}
	for _, record := range records {
		if len(record.Serialized) == 0 {
			continue
		}
		timestamp := strconv.FormatUint(record.TimestampUnixNano, 10)
		payload.Streams = append(payload.Streams, lokiStream{
			Stream: record.Labels,
			Values: [][2]string{{timestamp, string(record.Serialized)}},
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
