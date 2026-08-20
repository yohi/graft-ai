package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/dispatcher"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/ingress"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/sampling"
)

type config struct {
	address                  string
	trustedCIDRs             []string
	proxySecret              string
	hmacKeySource            ingress.SecretSource
	samplingRatePPM          uint32
	tempoURL                 string
	lokiURL                  string
	lokiPayloadEnabled       bool
	lokiPayloadDisableReason string
	prometheusURL            string
	tempoAuth                string
	lokiAuth                 string
	prometheusAuth           string
}

func loadConfig() (config, error) {
	proxySecret, err := requiredSecret("OTEL_INGEST_TOKEN", "OTEL_INGEST_TOKEN_FILE")
	if err != nil {
		return config{}, err
	}
	trustedCIDRs, err := splitRequiredEnv("OTEL_TRUSTED_PROXY_CIDRS")
	if err != nil {
		return config{}, err
	}
	hmacKeySource := ingress.SecretSource{
		FilePath:        strings.TrimSpace(os.Getenv("OTEL_RATE_LIMIT_HMAC_KEY_FILE")),
		EnvironmentName: "OTEL_RATE_LIMIT_HMAC_KEY",
	}
	if strings.TrimSpace(hmacKeySource.FilePath) == "" && strings.TrimSpace(os.Getenv(hmacKeySource.EnvironmentName)) == "" {
		return config{}, errors.New("OTEL_RATE_LIMIT_HMAC_KEY_FILE or OTEL_RATE_LIMIT_HMAC_KEY is required")
	}
	samplingRatePPM, err := sampling.ParseRatePPM(envOrDefault("OTEL_SAMPLING_RATE", defaultSamplingRate))
	if err != nil {
		return config{}, fmt.Errorf("parse OTEL_SAMPLING_RATE: %w", err)
	}
	tempoURL, err := endpointEnv("OTEL_TEMPO_URL", defaultTempoURL)
	if err != nil {
		return config{}, err
	}
	lokiURL, err := endpointEnv("OTEL_LOKI_URL", defaultLokiURL)
	if err != nil {
		return config{}, err
	}
	prometheusURL, err := endpointEnv("OTEL_PROMETHEUS_URL", defaultPrometheusURL)
	if err != nil {
		return config{}, err
	}
	lokiPayloadEnabled, lokiPayloadDisableReason := cloudLogsPayloadDecision(lokiURL)
	return config{
		address:                  envOrDefault("OTEL_HTTP_ADDR", defaultAddress),
		trustedCIDRs:             trustedCIDRs,
		proxySecret:              proxySecret,
		hmacKeySource:            hmacKeySource,
		samplingRatePPM:          samplingRatePPM,
		tempoURL:                 tempoURL,
		lokiURL:                  lokiURL,
		lokiPayloadEnabled:       lokiPayloadEnabled,
		lokiPayloadDisableReason: lokiPayloadDisableReason,
		prometheusURL:            prometheusURL,
		tempoAuth:                strings.TrimSpace(os.Getenv("OTEL_TEMPO_AUTHORIZATION")),
		lokiAuth:                 strings.TrimSpace(os.Getenv("OTEL_LOKI_AUTHORIZATION")),
		prometheusAuth:           strings.TrimSpace(os.Getenv("OTEL_PROMETHEUS_AUTHORIZATION")),
	}, nil
}

func requiredSecret(environmentName, fileEnvironmentName string) (string, error) {
	if value := strings.TrimSpace(os.Getenv(environmentName)); value != "" {
		return value, nil
	}
	filePath := strings.TrimSpace(os.Getenv(fileEnvironmentName))
	if filePath != "" {
		value, err := os.ReadFile(filePath)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", fileEnvironmentName, err)
		}
		if secret := strings.TrimSpace(string(value)); secret != "" {
			return secret, nil
		}
	}
	return "", fmt.Errorf("%s or %s is required", environmentName, fileEnvironmentName)
}

func endpointEnv(name, fallback string) (string, error) {
	value := envOrDefault(name, fallback)
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return "", fmt.Errorf("%s must be an HTTP(S) URL without embedded credentials", name)
	}
	return value, nil
}

func authHeader(value string) map[string]string {
	if value == "" {
		return nil
	}
	return map[string]string{"Authorization": value}
}

func tempoRetryPolicy() dispatcher.RetryPolicy {
	policy := dispatcher.DefaultRetryPolicy()
	policy.Backoff = []time.Duration{time.Second, 2 * time.Second}
	return policy
}

func requiredEnv(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func splitRequiredEnv(name string) ([]string, error) {
	value, err := requiredEnv(name)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(value, ",")
	for index := range parts {
		parts[index] = strings.TrimSpace(parts[index])
		if parts[index] == "" {
			return nil, fmt.Errorf("%s contains an empty CIDR", name)
		}
	}
	return parts, nil
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
