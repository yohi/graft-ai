package ingress

import (
	"errors"
	"math"
	"sync"
	"time"
)

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
}

type tokenBucket struct {
	tokens float64
	last   time.Time
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
	}, nil
}

func (l *RateLimiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	bucket, exists := l.buckets[key]
	if !exists {
		bucket = tokenBucket{tokens: l.capacity, last: now}
	}
	if elapsed := now.Sub(bucket.last).Seconds(); elapsed > 0 {
		bucket.tokens = math.Min(l.capacity, bucket.tokens+elapsed*l.refillPerSecond)
		bucket.last = now
	}
	if bucket.tokens >= 1 {
		bucket.tokens--
		l.buckets[key] = bucket
		return true, 0
	}
	seconds := (1 - bucket.tokens) / l.refillPerSecond
	retryAfter := time.Duration(math.Ceil(seconds * float64(time.Second)))
	retryAfter = max(retryAfter, time.Second)
	l.buckets[key] = bucket
	return false, retryAfter
}
