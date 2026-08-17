package ingress

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestSourceIdentity_resolves_trusted_cloudflare_source(t *testing.T) {
	identity, err := NewSourceIdentity([]string{"127.0.0.1/32"}, []byte("hmac-key"))
	if err != nil {
		t.Fatalf("new source identity: %v", err)
	}

	headers := make(http.Header)
	headers.Set("CF-Connecting-IP", "203.0.113.9")
	headers.Set("X-Forwarded-For", "198.51.100.2")
	source, err := identity.Resolve("127.0.0.1:4318", headers)
	if err != nil {
		t.Fatalf("resolve trusted source: %v", err)
	}
	if source != "203.0.113.9" {
		t.Fatalf("source = %q, want CF-Connecting-IP", source)
	}
}

func TestSourceIdentity_rejects_untrusted_peer_before_forwarded_headers(t *testing.T) {
	identity, err := NewSourceIdentity([]string{"127.0.0.1/32"}, []byte("hmac-key"))
	if err != nil {
		t.Fatalf("new source identity: %v", err)
	}

	_, err = identity.Resolve("198.51.100.10:4318", http.Header{"CF-Connecting-IP": {"203.0.113.9"}})
	if !errors.Is(err, ErrUntrustedSource) {
		t.Fatalf("error = %v, want ErrUntrustedSource", err)
	}
}

func TestSourceIdentity_fallbacks_to_peer_ip_when_forwarded_header_missing_or_invalid(t *testing.T) {
	identity, err := NewSourceIdentity([]string{"127.0.0.1/32"}, []byte("hmac-key"))
	if err != nil {
		t.Fatalf("new source identity: %v", err)
	}

	for name, headers := range map[string]http.Header{
		"missing": {},
		"invalid": {"CF-Connecting-IP": {"not-an-ip"}},
		"spoof-only": {"X-Forwarded-For": {"203.0.113.9"}},
	} {
		t.Run(name, func(t *testing.T) {
			source, err := identity.Resolve("127.0.0.1:4318", headers)
			if err != nil {
				t.Fatalf("resolve source: %v", err)
			}
			if source != "127.0.0.1" {
				t.Fatalf("source = %q, want peer IP fallback", source)
			}
		})
	}
}

func TestSourceIdentity_hash_matches_domain_separated_hmac(t *testing.T) {
	key := []byte("hmac-key")
	identity, err := NewSourceIdentity([]string{"127.0.0.1/32"}, key)
	if err != nil {
		t.Fatalf("new source identity: %v", err)
	}

	got := identity.Hash("203.0.113.9")
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("otel-ingress-source-v1\x00"))
	_, _ = mac.Write([]byte("203.0.113.9"))
	want := hex.EncodeToString(mac.Sum(nil))
	if got != want {
		t.Fatalf("hash = %q, want %q", got, want)
	}
	if got == "203.0.113.9" {
		t.Fatalf("raw source leaked as hash")
	}
}

func TestLoadHMACKey_uses_file_environment_and_store_sources(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "hmac-key")
	if err := os.WriteFile(filePath, []byte(" file-secret\n"), 0o600); err != nil {
		t.Fatalf("write key file: %v", err)
	}

	fileKey, err := LoadHMACKey(context.Background(), SecretSource{FilePath: filePath})
	if err != nil || string(fileKey) != "file-secret" {
		t.Fatalf("file key = %q, err = %v", fileKey, err)
	}

	t.Setenv("TEST_HMAC_KEY", "env-secret")
	envKey, err := LoadHMACKey(context.Background(), SecretSource{EnvironmentName: "TEST_HMAC_KEY"})
	if err != nil || string(envKey) != "env-secret" {
		t.Fatalf("environment key = %q, err = %v", envKey, err)
	}

	storeKey, err := LoadHMACKey(context.Background(), SecretSource{
		StoreName: "otel-key",
		Store:     fakeSecretStore{value: "store-secret"},
	})
	if err != nil || string(storeKey) != "store-secret" {
		t.Fatalf("store key = %q, err = %v", storeKey, err)
	}
}

func TestLoadHMACKey_empty_file_falls_through_to_next_source(t *testing.T) {
	emptyFile := filepath.Join(t.TempDir(), "empty-hmac-key")
	if err := os.WriteFile(emptyFile, []byte("   \n"), 0o600); err != nil {
		t.Fatalf("write empty key file: %v", err)
	}

	t.Setenv("TEST_EMPTY_FILE_FALLTHROUGH", "env-from-empty-file")
	key, err := LoadHMACKey(context.Background(), SecretSource{
		FilePath:        emptyFile,
		EnvironmentName: "TEST_EMPTY_FILE_FALLTHROUGH",
	})
	if err != nil || string(key) != "env-from-empty-file" {
		t.Fatalf("key = %q, err = %v", key, err)
	}
}

func TestLoadHMACKey_file_read_error_returns_immediately(t *testing.T) {
	missingFile := filepath.Join(t.TempDir(), "does-not-exist")

	t.Setenv("TEST_FILE_ERROR_FALLTHROUGH", "env-from-error")
	_, err := LoadHMACKey(context.Background(), SecretSource{
		FilePath:        missingFile,
		EnvironmentName: "TEST_FILE_ERROR_FALLTHROUGH",
	})
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}

type fakeSecretStore struct {
	value string
}

func (s fakeSecretStore) Get(_ context.Context, name string) (string, error) {
	if name != "otel-key" {
		return "", errors.New("unexpected secret name")
	}
	return s.value, nil
}
