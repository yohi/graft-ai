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
		"lowercase":    "bearer ingest-token",
		"double-space": "Bearer  ingest-token",
	} {
		t.Run(name, func(t *testing.T) {
			request := httptestRequestWithHeader("Authorization", value)
			if err := authenticator.Authenticate(request.Header); err == nil {
				t.Fatalf("expected authentication failure")
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
