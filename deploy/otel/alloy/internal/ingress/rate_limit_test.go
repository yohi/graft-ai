package ingress

import (
	"testing"
	"time"
)

func TestRateLimiter_enforces_capacity_and_refill(t *testing.T) {
	now := time.Unix(100, 0)
	limiter := newRateLimiter(t, RateLimiterConfig{
		Capacity:        20,
		RefillPerSecond: 2,
		Now:             func() time.Time { return now },
	})

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
	limiter := newRateLimiter(t, RateLimiterConfig{
		Capacity:        1,
		RefillPerSecond: 1,
		Now:             time.Now,
	})

	allowed, _ := limiter.Allow("first-source")
	if !allowed {
		t.Fatalf("first source was rejected")
	}
	allowed, _ = limiter.Allow("second-source")
	if !allowed {
		t.Fatalf("second source shared the first bucket")
	}
}

func TestRateLimiter_evicts_idle_full_buckets(t *testing.T) {
	now := time.Unix(100, 0)
	limiter := newRateLimiter(t, RateLimiterConfig{
		Capacity:        2,
		RefillPerSecond: 1,
		Now:             func() time.Time { return now },
	})

	if allowed, _ := limiter.Allow("active-source"); !allowed {
		t.Fatal("first request should be allowed")
	}
	if allowed, _ := limiter.Allow("idle-source"); !allowed {
		t.Fatal("first request should be allowed")
	}

	now = now.Add(10 * time.Minute)
	// active-source keeps its bucket by consuming a token; idle-source is full and idle so it is evicted.
	if allowed, _ := limiter.Allow("active-source"); !allowed {
		t.Fatal("active source should still be allowed after refill")
	}
	if got := len(limiter.buckets); got != 1 {
		t.Fatalf("bucket count = %d, want 1 after evicting idle full bucket", got)
	}
	if allowed, _ := limiter.Allow("idle-source"); !allowed {
		t.Fatal("idle source should be treated as a new source after eviction")
	}
}
func TestRateLimiter_does_not_evict_recent_full_buckets(t *testing.T) {
	now := time.Unix(100, 0)
	limiter := newRateLimiter(t, RateLimiterConfig{
		Capacity:        2,
		RefillPerSecond: 1,
		Now:             func() time.Time { return now },
	})

	if allowed, _ := limiter.Allow("recent-source"); !allowed {
		t.Fatal("first request should be allowed")
	}
	now = now.Add(10 * time.Second)
	if allowed, _ := limiter.Allow("recent-source"); !allowed {
		t.Fatal("recent source should still be allowed before idle TTL")
	}
	if got := len(limiter.buckets); got != 1 {
		t.Fatalf("bucket count = %d, want 1 while source remains active", got)
	}
}

func TestRateLimiter_evicts_idle_partially_used_buckets(t *testing.T) {
	now := time.Unix(100, 0)
	limiter := newRateLimiter(t, RateLimiterConfig{
		Capacity:        20,
		RefillPerSecond: 1,
		Now:             func() time.Time { return now },
	})

	if allowed, _ := limiter.Allow("idle-partial"); !allowed {
		t.Fatal("first request should be allowed")
	}
	// Leave the bucket partially drained so the old evictIdle would never remove it.
	now = now.Add(10 * time.Minute)
	if allowed, _ := limiter.Allow("other-source"); !allowed {
		t.Fatal("other request should be allowed")
	}
	if got := len(limiter.buckets); got != 1 {
		t.Fatalf("bucket count = %d, want 1 after idle partial bucket is evicted", got)
	}
	if allowed, _ := limiter.Allow("idle-partial"); !allowed {
		t.Fatal("evicted partial bucket should be recreated as full")
	}
}

func TestRateLimiter_rejection_keeps_bucket_alive(t *testing.T) {
	now := time.Unix(100, 0)
	limiter := newRateLimiter(t, RateLimiterConfig{
		Capacity:        1,
		RefillPerSecond: 1,
		Now:             func() time.Time { return now },
	})

	if allowed, _ := limiter.Allow("client"); !allowed {
		t.Fatal("first request should be allowed")
	}
	if allowed, _ := limiter.Allow("client"); allowed {
		t.Fatal("second request should be rate limited")
	}

	now = now.Add(3 * time.Minute)
	// The bucket must still exist because the rejection above updated lastAccess.
	_, _ = limiter.Allow("client")
	if got := len(limiter.buckets); got != 1 {
		t.Fatalf("bucket count = %d, want 1 after rejection keeps bucket alive", got)
	}
}


func newRateLimiter(t *testing.T, cfg RateLimiterConfig) *RateLimiter {
	t.Helper()
	limiter, err := NewRateLimiter(cfg)
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}
	return limiter
}
