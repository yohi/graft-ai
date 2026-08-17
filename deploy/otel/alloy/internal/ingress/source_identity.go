package ingress

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
)

var ErrUntrustedSource = errors.New("otel ingress: untrusted source")

type SecretStore interface {
	Get(context.Context, string) (string, error)
}

type SecretSource struct {
	FilePath        string
	EnvironmentName string
	StoreName       string
	Store           SecretStore
}

func LoadHMACKey(ctx context.Context, source SecretSource) ([]byte, error) {
	if source.FilePath != "" {
		value, err := os.ReadFile(source.FilePath)
		if err != nil {
			return nil, fmt.Errorf("read HMAC key file: %w", err)
		}
		key := strings.TrimSpace(string(value))
		if key == "" {
			// Empty configured file is treated the same as a missing source so
			// fallthrough to the next source instead of failing immediately.
		} else {
			return []byte(key), nil
		}
	}
	if source.EnvironmentName != "" {
		key := strings.TrimSpace(os.Getenv(source.EnvironmentName))
		if key != "" {
			return []byte(key), nil
		}
	}
	if source.StoreName != "" && source.Store != nil {
		value, err := source.Store.Get(ctx, source.StoreName)
		if err != nil {
			return nil, fmt.Errorf("load HMAC key from secret store: %w", err)
		}
		key := strings.TrimSpace(value)
		if key != "" {
			return []byte(key), nil
		}
	}
	return nil, errors.New("otel ingress: no HMAC key source produced a value")
}

type SourceIdentity struct {
	trustedNetworks []*net.IPNet
	hmacKey         []byte
}

func NewSourceIdentity(trustedCIDRs []string, hmacKey []byte) (SourceIdentity, error) {
	if len(trustedCIDRs) == 0 {
		return SourceIdentity{}, errors.New("otel ingress: trusted proxy CIDRs are empty")
	}
	if len(hmacKey) == 0 {
		return SourceIdentity{}, errors.New("otel ingress: HMAC key is empty")
	}
	networks := make([]*net.IPNet, 0, len(trustedCIDRs))
	for _, rawCIDR := range trustedCIDRs {
		_, network, err := net.ParseCIDR(strings.TrimSpace(rawCIDR))
		if err != nil {
			return SourceIdentity{}, fmt.Errorf("parse trusted proxy CIDR %q: %w", rawCIDR, err)
		}
		networks = append(networks, network)
	}
	return SourceIdentity{trustedNetworks: networks, hmacKey: append([]byte(nil), hmacKey...)}, nil
}

func (s SourceIdentity) Resolve(remoteAddr string, headers http.Header) (string, error) {
	peer := net.ParseIP(remoteAddr)
	if peer == nil {
		host, _, err := net.SplitHostPort(remoteAddr)
		if err != nil {
			return "", fmt.Errorf("parse source peer %q: %w", remoteAddr, ErrUntrustedSource)
		}
		peer = net.ParseIP(host)
	}
	if peer == nil || !s.isTrusted(peer) {
		return "", ErrUntrustedSource
	}
	forwarded := net.ParseIP(strings.TrimSpace(headers.Get("CF-Connecting-IP")))
	if forwarded == nil {
		return peer.String(), nil
	}
	if ipv4 := forwarded.To4(); ipv4 != nil {
		return ipv4.String(), nil
	}
	return forwarded.String(), nil
}

func (s SourceIdentity) Hash(canonicalSource string) string {
	mac := hmac.New(sha256.New, s.hmacKey)
	_, _ = mac.Write([]byte("otel-ingress-source-v1\x00"))
	_, _ = mac.Write([]byte(canonicalSource))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s SourceIdentity) isTrusted(peer net.IP) bool {
	for _, network := range s.trustedNetworks {
		if network.Contains(peer) {
			return true
		}
	}
	return false
}
