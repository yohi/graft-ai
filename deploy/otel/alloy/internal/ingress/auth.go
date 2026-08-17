package ingress

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

var ErrUnauthorized = errors.New("otel ingress: unauthorized")

type BearerAuthenticator struct {
	token []byte
}

func NewBearerAuthenticator(token string) (BearerAuthenticator, error) {
	if strings.TrimSpace(token) == "" {
		return BearerAuthenticator{}, errors.New("otel ingress: bearer token is empty")
	}
	return BearerAuthenticator{token: []byte(token)}, nil
}

func (a BearerAuthenticator) Authenticate(headers http.Header) error {
	value := headers.Get("Authorization")
	if !hasBearerScheme(value) {
		return ErrUnauthorized
	}
	provided := strings.TrimSpace(value[len("Bearer "):])
	if provided == "" || strings.ContainsAny(provided, " \t") {
		return ErrUnauthorized
	}
	if subtle.ConstantTimeCompare([]byte(provided), a.token) != 1 {
		return ErrUnauthorized
	}
	return nil
}

func hasBearerScheme(value string) bool {
	const scheme = "Bearer"
	if len(value) < len(scheme)+1 {
		return false
	}
	if !strings.EqualFold(value[:len(scheme)], scheme) {
		return false
	}
	return value[len(scheme)] == ' ' && !strings.HasPrefix(value[len(scheme)+1:], " ")
}
