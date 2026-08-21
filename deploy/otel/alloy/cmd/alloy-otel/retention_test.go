package main

import (
	"testing"
	"time"
)

func TestEvaluateCloudLogsRetention_allows_only_positive_values_up_to_fourteen_days(t *testing.T) {
	tests := []struct {
		name       string
		value      string
		wantEnable bool
		wantReason string
		wantValue  time.Duration
	}{
		{name: "one day", value: "1d", wantEnable: true, wantValue: 24 * time.Hour},
		{name: "fourteen days", value: "14d", wantEnable: true, wantValue: 14 * 24 * time.Hour},
		{name: "missing", value: "", wantReason: "retention_unavailable"},
		{name: "invalid", value: "not-a-duration", wantReason: "retention_invalid"},
		{name: "zero", value: "0d", wantReason: "retention_invalid"},
		{name: "too long", value: "15d", wantReason: "retention_exceeds_14d", wantValue: 15 * 24 * time.Hour},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decision := evaluateCloudLogsRetention(tt.value)
			if decision.Enabled != tt.wantEnable || decision.Reason != tt.wantReason || decision.Duration != tt.wantValue {
				t.Fatalf("decision = %#v, want enabled=%v reason=%q duration=%s", decision, tt.wantEnable, tt.wantReason, tt.wantValue)
			}
		})
	}
}

func TestLoadConfig_disablesGrafanaCloudPayloadExport_without_valid_retention(t *testing.T) {
	setRequiredConfig(t)
	t.Setenv("OTEL_LOKI_URL", "https://logs-prod.grafana.net/loki/api/v1/push")
	t.Setenv("OTEL_GRAFANA_CLOUD_LOGS_RETENTION", "")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.lokiPayloadEnabled || cfg.lokiPayloadDisableReason != "retention_unavailable" {
		t.Fatalf("cloud Loki payload gate = enabled=%v reason=%q", cfg.lokiPayloadEnabled, cfg.lokiPayloadDisableReason)
	}
}

func setRequiredConfig(t *testing.T) {
	t.Helper()
	t.Setenv("OTEL_INGEST_TOKEN", "ingest-token")
	t.Setenv("OTEL_TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	t.Setenv("OTEL_RATE_LIMIT_HMAC_KEY", "hmac-key")
	t.Setenv("OTEL_SAMPLING_RATE", "1")
}
