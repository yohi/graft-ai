package dispatcher

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http"
	"time"
)

type HTTPError struct {
	Status int
}

func (e *HTTPError) Error() string {
	return http.StatusText(e.Status)
}

type RetryPolicy struct {
	Attempts int
	Backoff  []time.Duration
	Sleep    func(context.Context, time.Duration) error
	Jitter   func(time.Duration) time.Duration
}

func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{
		Attempts: 3,
		Backoff:  []time.Duration{500 * time.Millisecond, time.Second},
		Sleep:    sleep,
		Jitter:   jitter,
	}
}

func (p RetryPolicy) Retryable(err error) bool {
	var httpError *HTTPError
	if !errors.As(err, &httpError) {
		return true
	}
	return httpError.Status == http.StatusRequestTimeout ||
		httpError.Status == http.StatusTooManyRequests ||
		httpError.Status >= http.StatusInternalServerError
}

func (p RetryPolicy) wait(ctx context.Context, retryIndex int) error {
	if retryIndex >= len(p.Backoff) {
		return nil
	}
	sleepFn := p.Sleep
	if sleepFn == nil {
		sleepFn = sleep
	}
	delay := p.Backoff[retryIndex]
	if p.Jitter != nil {
		delay = p.Jitter(delay)
	}
	return sleepFn(ctx, delay)
}

func jitter(duration time.Duration) time.Duration {
	factor := 0.8 + rand.Float64()*0.4
	return time.Duration(float64(duration) * factor)
}

func sleep(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
