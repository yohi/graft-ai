package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/ingress"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/sampling"
)

const (
	defaultAddress          = ":4318"
	defaultMaxBodyBytes     = 8 * 1024 * 1024
	defaultMaxConcurrent    = 100
	defaultIngressQueueSize = 1000
	defaultRateCapacity     = 20
	defaultRateRefill       = 2
	defaultForwarderCount   = 4
	defaultForwardTimeout   = 10 * time.Second
	defaultForwardURL       = "http://localhost:12345/v1/traces"
	defaultSamplingRate     = "1"
)

type config struct {
	address         string
	trustedCIDRs    []string
	proxySecret     string
	hmacKeySource   ingress.SecretSource
	forwardURL      string
	samplingRatePPM uint32
}

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
	server := ingress.NewHTTPServer(receiver)
	server.Addr = cfg.address

	forwarderCtx, stopForwarders := context.WithCancel(context.Background())
	defer stopForwarders()
	forwarderClient := &http.Client{Timeout: defaultForwardTimeout}
	var forwarderWg sync.WaitGroup
	for range defaultForwarderCount {
		forwarderWg.Add(1)
		go func() {
			defer forwarderWg.Done()
			forwardLoop(forwarderCtx, forwarderClient, cfg.forwardURL, queue)
		}()
	}

	err = serveUntilSignal(server)
	queue.Close()
	forwarderWg.Wait()
	stopForwarders()
	return err
}

func loadConfig() (config, error) {
	proxySecret, err := requiredEnv("OTEL_INGEST_TOKEN")
	if err != nil {
		return config{}, err
	}
	trustedCIDRs, err := splitRequiredEnv("OTEL_TRUSTED_PROXY_CIDRS")
	if err != nil {
		return config{}, err
	}
	hmacKeySource := ingress.SecretSource{
		FilePath:        os.Getenv("OTEL_RATE_LIMIT_HMAC_KEY_FILE"),
		EnvironmentName: "OTEL_RATE_LIMIT_HMAC_KEY",
	}
	if strings.TrimSpace(hmacKeySource.FilePath) == "" && strings.TrimSpace(os.Getenv(hmacKeySource.EnvironmentName)) == "" {
		return config{}, errors.New("OTEL_RATE_LIMIT_HMAC_KEY_FILE or OTEL_RATE_LIMIT_HMAC_KEY is required")
	}
	samplingRatePPM, err := sampling.ParseRatePPM(envOrDefault("OTEL_SAMPLING_RATE", defaultSamplingRate))
	if err != nil {
		return config{}, fmt.Errorf("parse OTEL_SAMPLING_RATE: %w", err)
	}
	return config{
		address:         envOrDefault("OTEL_HTTP_ADDR", defaultAddress),
		trustedCIDRs:    trustedCIDRs,
		proxySecret:     proxySecret,
		hmacKeySource:   hmacKeySource,
		forwardURL:      envOrDefault("OTEL_ALLOY_FORWARD_URL", defaultForwardURL),
		samplingRatePPM: samplingRatePPM,
	}, nil
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

func forwardLoop(ctx context.Context, client *http.Client, url string, queue *ingress.IngressQueue) {
	for {
		envelope, ok := queue.Dequeue(ctx)
		if !ok {
			return
		}
		if err := forwardEnvelope(ctx, client, url, envelope); err != nil {
			slog.Error("failed to forward envelope", "error", err)
		}
	}
}

func forwardEnvelope(ctx context.Context, client *http.Client, url string, envelope ingress.Envelope) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(envelope.Payload))
	if err != nil {
		return fmt.Errorf("build forward request: %w", err)
	}
	request.Header.Set("Content-Type", envelope.ContentType)

	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("forward envelope: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode >= http.StatusBadRequest {
		body, _ := io.ReadAll(response.Body)
		return fmt.Errorf("forward envelope: downstream returned %d: %s", response.StatusCode, string(body))
	}
	return nil
}

func requiredEnv(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func splitRequiredEnv(name string) ([]string, error) {
	value, err := requiredEnv(name)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(value, ",")
	for index := range parts {
		parts[index] = strings.TrimSpace(parts[index])
		if parts[index] == "" {
			return nil, fmt.Errorf("%s contains an empty CIDR", name)
		}
	}
	return parts, nil
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
