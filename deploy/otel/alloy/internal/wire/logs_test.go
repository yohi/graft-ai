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

func TestEncodeLoki_fills_only_canonical_labels_when_labels_are_missing(t *testing.T) {
	record := spanlogs.JSONLogRecord{
		Labels:     map[string]string{"model": "m", "unexpected": "value"},
		Serialized: []byte(`{"hello":"world"}`),
	}

	payload, err := EncodeLoki([]spanlogs.JSONLogRecord{record})
	if err != nil {
		t.Fatalf("EncodeLoki: %v", err)
	}

	var decoded struct {
		Streams []struct {
			Stream map[string]string `json:"stream"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	labels := decoded.Streams[0].Stream
	if len(labels) != 4 {
		t.Fatalf("labels = %#v, want exactly four canonical labels", labels)
	}
	wantLabels := map[string]string{
		"model":       "m",
		"status_code": "unknown",
		"env":         "unknown",
		"gateway":     "unknown",
	}
	for key, want := range wantLabels {
		if got := labels[key]; got != want {
			t.Fatalf("label %q = %q, want %q", key, got, want)
		}
	}
	if _, ok := labels["unexpected"]; ok {
		t.Fatal("unexpected label was emitted")
	}
	if _, ok := labels["service_name"]; ok {
		t.Fatal("service_name fallback label was emitted")
	}
}
