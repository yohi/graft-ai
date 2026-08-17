package main

import "testing"

func TestLoadConfig_requires_ingress_secrets(t *testing.T) {
	t.Setenv("OTEL_INGEST_TOKEN", "")
	t.Setenv("OTEL_TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	t.Setenv("OTEL_RATE_LIMIT_HMAC_KEY", "hmac-key")
	if _, err := loadConfig(); err == nil {
		t.Fatalf("loadConfig succeeded without OTEL_INGEST_TOKEN")
	}

	t.Setenv("OTEL_INGEST_TOKEN", "ingest-token")
	t.Setenv("OTEL_TRUSTED_PROXY_CIDRS", "")
	if _, err := loadConfig(); err == nil {
		t.Fatalf("loadConfig succeeded without OTEL_TRUSTED_PROXY_CIDRS")
	}

	t.Setenv("OTEL_TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	t.Setenv("OTEL_RATE_LIMIT_HMAC_KEY", "")
	t.Setenv("OTEL_RATE_LIMIT_HMAC_KEY_FILE", "")
	if _, err := loadConfig(); err == nil {
		t.Fatalf("loadConfig succeeded without an HMAC key source")
	}
}

func TestLoadConfig_keeps_ingress_contract_limits_fixed(t *testing.T) {
	t.Setenv("OTEL_INGEST_TOKEN", "ingest-token")
	t.Setenv("OTEL_TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	t.Setenv("OTEL_RATE_LIMIT_HMAC_KEY", "hmac-key")
	t.Setenv("OTEL_MAX_BODY_BYTES", "1")
	t.Setenv("OTEL_MAX_CONCURRENT_REQUESTS", "1")
	t.Setenv("OTEL_INGRESS_QUEUE_ITEMS", "1")
	t.Setenv("OTEL_RATE_LIMIT_CAPACITY", "1")
	t.Setenv("OTEL_RATE_LIMIT_REFILL_PER_SECOND", "1")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.address != defaultAddress {
		t.Fatalf("address = %q, want default %q", cfg.address, defaultAddress)
	}
}
