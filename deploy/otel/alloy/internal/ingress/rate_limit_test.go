package ingress

import (
	"testing"
	"time"
)

func TestRateLimiter_enforces_capacity_and_refill(t *testing.T) {
	now := time.Unix(100, 0)
	limiter, err := NewRateLimiter(RateLimiterConfig{
		Capacity:        20,
		RefillPerSecond: 2,
		Now:             func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}

	for range 20 {
		allowed, _ := limiter.Allow("source-hash")
		if !allowed {
			t.Fatalf("request was rate limited before capacity")
		}
	}
	allowed, retryAfter := limiter.Allow("source-hash")
	if allowed || retryAfter <= 0 {
		t.Fatalf("overflow result = allowed %v, retryAfter %v", allowed, retryAfter)
	}

	now = now.Add(500 * time.Millisecond)
	allowed, _ = limiter.Allow("source-hash")
	if !allowed {
		t.Fatalf("request was not accepted after one refill token")
	}
}

func TestRateLimiter_keeps_buckets_independent(t *testing.T) {
	limiter, err := NewRateLimiter(RateLimiterConfig{
		Capacity:        1,
		RefillPerSecond: 1,
		Now:             time.Now,
	})
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}

	allowed, _ := limiter.Allow("first-source")
	if !allowed {
		t.Fatalf("first source was rejected")
	}
	allowed, _ = limiter.Allow("second-source")
	if !allowed {
		t.Fatalf("second source shared the first bucket")
	}
}
