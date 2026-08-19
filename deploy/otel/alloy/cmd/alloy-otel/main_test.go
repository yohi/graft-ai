package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfig_parses_sampling_rate_as_integer_ppm(t *testing.T) {
	t.Setenv("OTEL_INGEST_TOKEN", "ingest-token")
	t.Setenv("OTEL_TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	t.Setenv("OTEL_RATE_LIMIT_HMAC_KEY", "hmac-key")
	t.Setenv("OTEL_SAMPLING_RATE", "0.5")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.samplingRatePPM != 500_000 {
		t.Fatalf("sampling rate ppm = %d, want 500000", cfg.samplingRatePPM)
	}

	t.Setenv("OTEL_SAMPLING_RATE", "1.000001")
	if _, err := loadConfig(); err == nil {
		t.Fatal("invalid sampling rate was accepted")
	}
}

func TestLoadConfig_reads_ingest_token_from_secret_file(t *testing.T) {
	t.Setenv("OTEL_INGEST_TOKEN", "")
	t.Setenv("OTEL_TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	t.Setenv("OTEL_RATE_LIMIT_HMAC_KEY", "hmac-key")
	secretPath := filepath.Join(t.TempDir(), "ingest-token")
	if err := os.WriteFile(secretPath, []byte("file-token\n"), 0o600); err != nil {
		t.Fatalf("write secret file: %v", err)
	}
	t.Setenv("OTEL_INGEST_TOKEN_FILE", secretPath)

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.proxySecret != "file-token" {
		t.Fatalf("proxy secret = %q, want file-token", cfg.proxySecret)
	}
}

func TestLoadConfig_rejects_backend_url_with_embedded_credentials(t *testing.T) {
	t.Setenv("OTEL_INGEST_TOKEN", "ingest-token")
	t.Setenv("OTEL_TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	t.Setenv("OTEL_RATE_LIMIT_HMAC_KEY", "hmac-key")
	t.Setenv("OTEL_TEMPO_URL", "http://user:password@tempo:4318/v1/traces")

	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig accepted backend URL with embedded credentials")
	}
}
