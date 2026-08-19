package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/dispatcher"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/ingress"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/sampling"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/selector"
)

const (
	defaultAddress          = ":4318"
	defaultMaxBodyBytes     = 8 * 1024 * 1024
	defaultMaxConcurrent    = 100
	defaultIngressQueueSize = 1000
	defaultRateCapacity     = 20
	defaultRateRefill       = 2
	defaultPipelineWorkers  = 1
	defaultSamplingRate     = "1"
	defaultTempoURL         = "http://tempo:4318/v1/traces"
	defaultLokiURL          = "http://loki:3100/loki/api/v1/push"
	defaultPrometheusURL    = "http://prometheus:9090/api/v1/otlp/v1/metrics"
	samplingSeed            = "graft-ai-otel-v1"
)

func main() {
	if err := run(); err != nil {
		slog.Error("alloy-otel failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	authenticator, err := ingress.NewBearerAuthenticator(cfg.proxySecret)
	if err != nil {
		return fmt.Errorf("configure bearer authenticator: %w", err)
	}
	hmacKey, err := ingress.LoadHMACKey(context.Background(), cfg.hmacKeySource)
	if err != nil {
		return fmt.Errorf("load source identity HMAC key: %w", err)
	}
	sourceIdentity, err := ingress.NewSourceIdentity(cfg.trustedCIDRs, hmacKey)
	if err != nil {
		return fmt.Errorf("configure source identity: %w", err)
	}
	queue, err := ingress.NewIngressQueue(defaultIngressQueueSize)
	if err != nil {
		return fmt.Errorf("configure ingress queue: %w", err)
	}
	rateLimiter, err := ingress.NewRateLimiter(ingress.RateLimiterConfig{
		Capacity:        defaultRateCapacity,
		RefillPerSecond: defaultRateRefill,
		Now:             time.Now,
	})
	if err != nil {
		return fmt.Errorf("configure rate limiter: %w", err)
	}
	receiver, err := ingress.NewReceiver(ingress.ReceiverConfig{
		Authenticator:         authenticator,
		SourceIdentity:        sourceIdentity,
		Queue:                 queue,
		RateLimiter:           rateLimiter,
		MaxBodyBytes:          defaultMaxBodyBytes,
		MaxConcurrentRequests: defaultMaxConcurrent,
		SamplingRatePPM:       cfg.samplingRatePPM,
	})
	if err != nil {
		return fmt.Errorf("configure receiver: %w", err)
	}
	sampler, err := sampling.NewSampler(samplingSeed)
	if err != nil {
		return fmt.Errorf("configure sampler: %w", err)
	}
	traceSelector, err := selector.NewRequestSelector(selector.DefaultMaxTraces, selector.DefaultMaxBytes, selector.DefaultIdle)
	if err != nil {
		return fmt.Errorf("configure trace selector: %w", err)
	}
	backendDispatcher, err := dispatcher.NewDispatcher(dispatcher.DispatcherConfig{
		Client: &http.Client{Timeout: 10 * time.Second},
		Backends: map[dispatcher.Backend]dispatcher.BackendConfig{
			dispatcher.Tempo:      {URL: cfg.tempoURL, Headers: authHeader(cfg.tempoAuth), MaxItems: 2_000, MaxBytes: 64 * 1024 * 1024, Retry: tempoRetryPolicy()},
			dispatcher.Loki:       {URL: cfg.lokiURL, Headers: authHeader(cfg.lokiAuth), MaxItems: 500, MaxBytes: 64 * 1024 * 1024, Retry: dispatcher.DefaultRetryPolicy()},
			dispatcher.Prometheus: {URL: cfg.prometheusURL, Headers: authHeader(cfg.prometheusAuth), MaxItems: 100, MaxBytes: 16 * 1024 * 1024, Retry: dispatcher.DefaultRetryPolicy()},
		},
	})
	if err != nil {
		return fmt.Errorf("configure backend dispatcher: %w", err)
	}
	forwarderCtx, stopForwarders := context.WithCancel(context.Background())
	backendDispatcher.Start(forwarderCtx)
	server := ingress.NewHTTPServer(receiver)
	server.Addr = cfg.address

	var forwarderWg sync.WaitGroup
	for range defaultPipelineWorkers {
		forwarderWg.Go(func() {
			processLoop(forwarderCtx, queue, traceSelector, sampler, backendDispatcher, cfg.samplingRatePPM)
		})
	}

	err = serveUntilSignal(server)
	queue.Close()
	forwarderWg.Wait()
	backendDispatcher.Close()
	stopForwarders()
	return err
}

func serveUntilSignal(server *http.Server) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.ListenAndServe() }()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown HTTP server: %w", err)
		}
		return nil
	case err := <-serverErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve HTTP: %w", err)
	}
}
