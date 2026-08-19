package wire

import (
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/spanlogs"
)

func TestEncodeLoki_replaces_zero_timestamp_with_now(t *testing.T) {
	record := spanlogs.JSONLogRecord{
		Labels:            map[string]string{"model": "m"},
		Serialized:        []byte(`{"hello":"world"}`),
		TimestampUnixNano: 0,
	}

	before := uint64(time.Now().UnixNano())
	payload, err := EncodeLoki([]spanlogs.JSONLogRecord{record})
	if err != nil {
		t.Fatalf("EncodeLoki: %v", err)
	}
	after := uint64(time.Now().UnixNano())

	var decoded struct {
		Streams []struct {
			Values [][2]string `json:"values"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	timestamp, err := strconv.ParseUint(decoded.Streams[0].Values[0][0], 10, 64)
	if err != nil {
		t.Fatalf("parse timestamp: %v", err)
	}
	if timestamp < before || timestamp > after {
		t.Fatalf("timestamp %d not in range [%d, %d]", timestamp, before, after)
	}
}
