package ingress

import (
	"errors"
	"math"
	"sync"
	"time"
)

const defaultBucketIdleTTL = 5 * time.Minute

type RateLimiterConfig struct {
	Capacity        int
	RefillPerSecond float64
	Now             func() time.Time
}

type RateLimiter struct {
	mu              sync.Mutex
	capacity        float64
	refillPerSecond float64
	now             func() time.Time
	buckets         map[string]tokenBucket
	idleTTL         time.Duration
}

type tokenBucket struct {
	tokens     float64
	last       time.Time
	lastAccess time.Time
}

func NewRateLimiter(config RateLimiterConfig) (*RateLimiter, error) {
	if config.Capacity <= 0 {
		return nil, errors.New("otel ingress: rate limit capacity must be positive")
	}
	if config.RefillPerSecond <= 0 {
		return nil, errors.New("otel ingress: rate limit refill must be positive")
	}
	if config.Now == nil {
		return nil, errors.New("otel ingress: rate limiter clock is nil")
	}
	return &RateLimiter{
		capacity:        float64(config.Capacity),
		refillPerSecond: config.RefillPerSecond,
		now:             config.Now,
		buckets:         make(map[string]tokenBucket),
		idleTTL:         defaultBucketIdleTTL,
	}, nil
}

func (l *RateLimiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.evictIdle(now)
	bucket, exists := l.buckets[key]
	if !exists {
		bucket = tokenBucket{tokens: l.capacity, last: now, lastAccess: now}
	}
	if elapsed := now.Sub(bucket.last).Seconds(); elapsed > 0 {
		bucket.tokens = math.Min(l.capacity, bucket.tokens+elapsed*l.refillPerSecond)
		bucket.last = now
	}
	if bucket.tokens >= 1 {
		bucket.tokens--
		bucket.lastAccess = now
		l.buckets[key] = bucket
		return true, 0
	}
	seconds := (1 - bucket.tokens) / l.refillPerSecond
	retryAfter := time.Duration(math.Ceil(seconds * float64(time.Second)))
	retryAfter = max(retryAfter, time.Second)
	l.buckets[key] = bucket
	return false, retryAfter
}

func (l *RateLimiter) evictIdle(now time.Time) {
	for key, bucket := range l.buckets {
		if now.Sub(bucket.lastAccess) >= l.idleTTL {
			delete(l.buckets, key)
		}
	}
}
