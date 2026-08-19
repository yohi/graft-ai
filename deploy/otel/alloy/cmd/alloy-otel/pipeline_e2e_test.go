package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	collectormetricspb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/dispatcher"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/ingress"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/sampling"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/selector"
)

type pipelineOutput struct {
	backend     dispatcher.Backend
	contentType string
	body        []byte
}

func TestPipeline_acceptsOTLPAndDeliversRedactedSignalsToAllBackends(t *testing.T) {
	outputs := make(chan pipelineOutput, 3)
	backendServer := func(backend dispatcher.Backend) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Errorf("read %s body: %v", backend, err)
				return
			}
			outputs <- pipelineOutput{backend: backend, contentType: request.Header.Get("Content-Type"), body: body}
			writer.WriteHeader(http.StatusOK)
		}))
	}
	tempoServer := backendServer(dispatcher.Tempo)
	defer tempoServer.Close()
	lokiServer := backendServer(dispatcher.Loki)
	defer lokiServer.Close()
	prometheusServer := backendServer(dispatcher.Prometheus)
	defer prometheusServer.Close()

	authenticator, err := ingress.NewBearerAuthenticator("ingest-token")
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}
	identity, err := ingress.NewSourceIdentity([]string{"127.0.0.1/32"}, []byte("hmac-key"))
	if err != nil {
		t.Fatalf("new source identity: %v", err)
	}
	queue, err := ingress.NewIngressQueue(10)
	if err != nil {
		t.Fatalf("new ingress queue: %v", err)
	}
	limiter, err := ingress.NewRateLimiter(ingress.RateLimiterConfig{Capacity: 10, RefillPerSecond: 1, Now: time.Now})
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}
	receiver, err := ingress.NewReceiver(ingress.ReceiverConfig{
		Authenticator:         authenticator,
		SourceIdentity:        identity,
		Queue:                 queue,
		RateLimiter:           limiter,
		MaxBodyBytes:          8 * 1024 * 1024,
		MaxConcurrentRequests: 100,
		SamplingRatePPM:       1_000_000,
	})
	if err != nil {
		t.Fatalf("new receiver: %v", err)
	}
	selectorState, err := selector.NewRequestSelector(100, 64*1024*1024, time.Second)
	if err != nil {
		t.Fatalf("new selector: %v", err)
	}
	sampler, err := sampling.NewSampler(samplingSeed)
	if err != nil {
		t.Fatalf("new sampler: %v", err)
	}
	backendDispatcher, err := dispatcher.NewDispatcher(dispatcher.DispatcherConfig{
		Client: &http.Client{Timeout: time.Second},
		Backends: map[dispatcher.Backend]dispatcher.BackendConfig{
			dispatcher.Tempo:      {URL: tempoServer.URL, MaxItems: 10, MaxBytes: 1 << 20},
			dispatcher.Loki:       {URL: lokiServer.URL, MaxItems: 10, MaxBytes: 1 << 20},
			dispatcher.Prometheus: {URL: prometheusServer.URL, MaxItems: 10, MaxBytes: 1 << 20},
		},
	})
	if err != nil {
		t.Fatalf("new dispatcher: %v", err)
	}
	backendDispatcher.Start(t.Context())
	processContext := t.Context()
	processDone := make(chan struct{})
	go func() {
		processLoop(processContext, queue, selectorState, sampler, backendDispatcher, 1_000_000)
		close(processDone)
	}()

	server := httptest.NewServer(receiver)
	defer server.Close()
	body, err := proto.Marshal(pipelineOTLPBody())
	if err != nil {
		t.Fatalf("marshal OTLP body: %v", err)
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/traces", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new OTLP request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer ingest-token")
	request.Header.Set("Content-Type", "application/x-protobuf")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("send OTLP request: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("OTLP status = %d, want 200", response.StatusCode)
	}

	queue.Close()
	select {
	case <-processDone:
	case <-time.After(2 * time.Second):
		t.Fatal("pipeline did not flush after ingress close")
	}
	backendDispatcher.Close()

	seen := make(map[dispatcher.Backend]pipelineOutput, 3)
	for len(seen) < 3 {
		select {
		case item := <-outputs:
			seen[item.backend] = item
		case <-time.After(2 * time.Second):
			t.Fatalf("received %d backend outputs, want 3", len(seen))
		}
	}
	assertPipelineTempo(t, seen[dispatcher.Tempo])
	assertPipelineLoki(t, seen[dispatcher.Loki])
	assertPipelineMetrics(t, seen[dispatcher.Prometheus])
}

func pipelineOTLPBody() *collectortracepb.ExportTraceServiceRequest {
	return &collectortracepb.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{
			{
				TraceId: []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff},
				SpanId:  []byte{0x01, 0x12, 0x23, 0x34, 0x45, 0x56, 0x67, 0x78},
				Name:    "request",
				Kind:    tracepb.Span_SPAN_KIND_SERVER,
				Attributes: []*commonpb.KeyValue{
					{Key: "model", Value: stringAny("llama")},
					{Key: "provider", Value: stringAny("cloudflare")},
					{Key: "status_code", Value: intAny(200)},
					{Key: "env", Value: stringAny("test")},
					{Key: "gateway", Value: stringAny("main")},
					{Key: "request_id", Value: stringAny("request-1")},
					{Key: "gen_ai.prompt_json", Value: stringAny(`{"prompt":"Bearer prompt-secret","token":"sk-live-secret"}`)},
				},
			},
			{
				TraceId:      []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff},
				SpanId:       []byte{0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87},
				ParentSpanId: []byte{0x01, 0x12, 0x23, 0x34, 0x45, 0x56, 0x67, 0x78},
				Name:         "provider",
				Kind:         tracepb.Span_SPAN_KIND_CLIENT,
			},
		}}},
	}}}
}

func stringAny(value string) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}}
}

func intAny(value int64) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: value}}
}

func assertPipelineTempo(t *testing.T, output pipelineOutput) {
	t.Helper()
	if output.contentType != "application/x-protobuf" {
		t.Fatalf("Tempo content type = %q", output.contentType)
	}
	payload := &collectortracepb.ExportTraceServiceRequest{}
	if err := proto.Unmarshal(output.body, payload); err != nil {
		t.Fatalf("decode Tempo payload: %v", err)
	}
	if got := len(payload.GetResourceSpans()[0].GetScopeSpans()[0].GetSpans()); got != 2 {
		t.Fatalf("Tempo spans = %d, want 2", got)
	}
	if bytes.Contains(output.body, []byte("prompt-secret")) || bytes.Contains(output.body, []byte("sk-live-secret")) {
		t.Fatal("Tempo payload contains credential-like payload")
	}
}

func assertPipelineLoki(t *testing.T, output pipelineOutput) {
	t.Helper()
	if output.contentType != "application/json" {
		t.Fatalf("Loki content type = %q", output.contentType)
	}
	var payload struct {
		Streams []struct {
			Stream map[string]string `json:"stream"`
			Values [][2]string       `json:"values"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(output.body, &payload); err != nil {
		t.Fatalf("decode Loki payload: %v", err)
	}
	if len(payload.Streams) != 1 || len(payload.Streams[0].Values) != 1 {
		t.Fatalf("Loki streams = %#v", payload.Streams)
	}
	line := payload.Streams[0].Values[0][1]
	if !bytes.Contains([]byte(line), []byte("[REDACTED]")) || bytes.Contains([]byte(line), []byte("sk-live-secret")) {
		t.Fatalf("Loki line did not preserve safe redaction: %s", line)
	}
	for _, label := range []string{"model", "status_code", "env", "gateway"} {
		if _, ok := payload.Streams[0].Stream[label]; !ok {
			t.Fatalf("Loki label %q missing", label)
		}
	}
}

func assertPipelineMetrics(t *testing.T, output pipelineOutput) {
	t.Helper()
	if output.contentType != "application/x-protobuf" {
		t.Fatalf("Prometheus content type = %q", output.contentType)
	}
	payload := &collectormetricspb.ExportMetricsServiceRequest{}
	if err := proto.Unmarshal(output.body, payload); err != nil {
		t.Fatalf("decode Prometheus payload: %v", err)
	}
	metrics := payload.GetResourceMetrics()[0].GetScopeMetrics()[0].GetMetrics()
	if len(metrics) < 2 {
		t.Fatalf("metrics = %d, want request and duration", len(metrics))
	}
	if metrics[0].GetName() != "ai_gateway_requests_total" {
		t.Fatalf("first metric = %q", metrics[0].GetName())
	}
}
