package main

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const maxCloudLogsPayloadRetention = 14 * 24 * time.Hour

type cloudLogsRetentionDecision struct {
	Enabled  bool
	Duration time.Duration
	Reason   string
}

func evaluateCloudLogsRetention(value string) cloudLogsRetentionDecision {
	value = strings.TrimSpace(value)
	if value == "" {
		return cloudLogsRetentionDecision{Reason: "retention_unavailable"}
	}
	duration, err := parseCloudLogsRetention(value)
	if err != nil || duration <= 0 {
		return cloudLogsRetentionDecision{Reason: "retention_invalid"}
	}
	if duration > maxCloudLogsPayloadRetention {
		return cloudLogsRetentionDecision{Duration: duration, Reason: "retention_exceeds_14d"}
	}
	return cloudLogsRetentionDecision{Enabled: true, Duration: duration}
}

func parseCloudLogsRetention(value string) (time.Duration, error) {
	value = strings.TrimSpace(value)
	for _, unit := range []struct {
		suffix   string
		duration time.Duration
	}{
		{suffix: "d", duration: 24 * time.Hour},
		{suffix: "h", duration: time.Hour},
		{suffix: "m", duration: time.Minute},
		{suffix: "s", duration: time.Second},
	} {
		if !strings.HasSuffix(value, unit.suffix) {
			continue
		}
		count, err := strconv.ParseInt(strings.TrimSuffix(value, unit.suffix), 10, 64)
		const maxInt64 = int64(1<<63 - 1)
		if err != nil || count <= 0 || count > maxInt64/int64(unit.duration) {
			return 0, fmt.Errorf("invalid retention duration %q", value)
		}
		return time.Duration(count) * unit.duration, nil
	}
	return 0, fmt.Errorf("invalid retention duration %q", value)
}

func cloudLogsPayloadDecision(lokiURL string) (bool, string) {
	if !isGrafanaCloudLokiURL(lokiURL) {
		return true, ""
	}
	value, err := cloudLogsRetentionValue()
	if err != nil {
		return false, "retention_lookup_failed"
	}
	decision := evaluateCloudLogsRetention(value)
	return decision.Enabled, decision.Reason
}

func cloudLogsRetentionValue() (string, error) {
	filePath := strings.TrimSpace(os.Getenv("OTEL_GRAFANA_CLOUD_LOGS_RETENTION_FILE"))
	if filePath != "" {
		value, err := os.ReadFile(filePath)
		if err != nil {
			return "", err
		}
		return string(value), nil
	}
	return os.Getenv("OTEL_GRAFANA_CLOUD_LOGS_RETENTION"), nil
}

func isGrafanaCloudLokiURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return strings.HasSuffix(host, ".grafana.net") || strings.HasSuffix(host, ".grafana.com")
}
