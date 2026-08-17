package ingress

import (
	"net/http"
	"testing"
)

func TestBearerAuthenticator_accepts_exact_token(t *testing.T) {
	authenticator, err := NewBearerAuthenticator("ingest-token")
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}

	request := httptestRequestWithHeader("Authorization", "Bearer ingest-token")
	if err := authenticator.Authenticate(request.Header); err != nil {
		t.Fatalf("authenticate valid token: %v", err)
	}
}

func TestBearerAuthenticator_rejects_missing_or_malformed_token(t *testing.T) {
	authenticator, err := NewBearerAuthenticator("ingest-token")
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}

	for name, value := range map[string]string{
		"missing":      "",
		"basic":        "Basic ingest-token",
		"wrong":        "Bearer wrong-token",
		"extra":        "Bearer ingest-token extra",
		"double-space": "Bearer  ingest-token",
		"no-space":     "Bearer",
		"space-at-end": "Bearer ",
	} {
		t.Run(name, func(t *testing.T) {
			request := httptestRequestWithHeader("Authorization", value)
			if err := authenticator.Authenticate(request.Header); err == nil {
				t.Fatalf("expected authentication failure")
			}
		})
	}
}

func TestBearerAuthenticator_accepts_lowercase_bearer_scheme(t *testing.T) {
	authenticator, err := NewBearerAuthenticator("ingest-token")
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}

	for _, value := range []string{"bearer ingest-token", "Bearer ingest-token", "BEARER ingest-token"} {
		t.Run(value, func(t *testing.T) {
			request := httptestRequestWithHeader("Authorization", value)
			if err := authenticator.Authenticate(request.Header); err != nil {
				t.Fatalf("authenticate %q: %v", value, err)
			}
		})
	}
}

func httptestRequestWithHeader(name, value string) *http.Request {
	request, err := http.NewRequest(http.MethodPost, "http://example.test/v1/traces", nil)
	if err != nil {
		panic(err)
	}
	request.Header.Set(name, value)
	return request
}
