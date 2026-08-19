package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/dispatcher"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/fanout"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/ingress"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/metrics"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/sampling"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/selector"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/wire"
)

func processLoop(ctx context.Context, queue *ingress.IngressQueue, traceSelector *selector.RequestSelector, sampler sampling.Sampler, backendDispatcher *dispatcher.Dispatcher, ratePPM uint32) {
	brancher := fanout.NewFanOut(sampler)
	ticker := time.NewTicker(selector.DefaultIdle / 2)
	defer ticker.Stop()
	metricsTicker := time.NewTicker(30 * time.Second)
	defer metricsTicker.Stop()
	accumulator := metrics.NewAccumulator()
	accumulatorStart := wire.TimestampNow()
	for {
		select {
		case envelope, ok := <-queue.Items():
			if !ok {
				for _, trace := range traceSelector.FlushAll() {
					dispatchTrace(ctx, brancher, backendDispatcher, trace, ratePPM, accumulator)
				}
				flushAccumulator(ctx, accumulator, accumulatorStart, backendDispatcher)
				return
			}
			traceSelector.AddAt(envelope.Span, envelope.ReceivedAt)
		case now := <-ticker.C:
			for _, trace := range traceSelector.FlushIdle(now) {
				dispatchTrace(ctx, brancher, backendDispatcher, trace, ratePPM, accumulator)
			}
		case <-metricsTicker.C:
			flushAccumulator(ctx, accumulator, accumulatorStart, backendDispatcher)
			accumulatorStart = wire.TimestampNow()
			logDispatcherMetrics(ctx, backendDispatcher.Snapshot())
		case <-ctx.Done():
			return
		}
	}
}

func logDispatcherMetrics(ctx context.Context, snapshot dispatcher.MetricsSnapshot) {
	for backend, value := range snapshot.Retries {
		slog.InfoContext(ctx, "dispatcher metrics", "backend", backend, "retries", value)
	}
	for backend, value := range snapshot.Failures {
		slog.InfoContext(ctx, "dispatcher metrics", "backend", backend, "failures", value)
	}
	for backend, value := range snapshot.Exhausted {
		slog.InfoContext(ctx, "dispatcher metrics", "backend", backend, "exhausted", value)
	}
	for backend, value := range snapshot.Drops {
		slog.InfoContext(ctx, "dispatcher metrics", "backend", backend, "drops", value)
	}
}

func dispatchTrace(ctx context.Context, brancher fanout.FanOut, backendDispatcher *dispatcher.Dispatcher, trace selector.Trace, ratePPM uint32, accumulator *metrics.Accumulator) {
	result, err := brancher.Trace(trace, ratePPM)
	if err != nil {
		slog.ErrorContext(ctx, "failed to process OTel trace", "trace_id", trace.TraceID, "error", err)
		return
	}
	for _, sample := range result.Metrics.Samples {
		if err := accumulator.Add(sample); err != nil {
			slog.ErrorContext(ctx, "failed to accumulate metric sample", "trace_id", trace.TraceID, "metric", sample.Name, "error", err)
		}
	}
	if !result.Sampled {
		return
	}
	tempoPayload, err := wire.EncodeTempo(result.Tempo)
	if err != nil {
		slog.ErrorContext(ctx, "failed to encode Tempo trace", "trace_id", trace.TraceID, "error", err)
	} else if len(tempoPayload) > 0 {
		if result := backendDispatcher.Handoff(dispatcher.Output{
			Backend:     dispatcher.Tempo,
			TraceID:     trace.TraceID,
			Payload:     tempoPayload,
			ContentType: "application/x-protobuf",
			Priority:    2,
			Units:       len(result.Tempo),
			ReceivedAt:  trace.ReceivedAt,
		}); result.Dropped {
			slog.WarnContext(ctx, "dropped Tempo submission", "trace_id", trace.TraceID, "reason", result.Reason)
		}
	}
	lokiPayload, err := wire.EncodeLoki(result.Loki)
	if err != nil {
		slog.ErrorContext(ctx, "failed to encode Loki payload", "trace_id", trace.TraceID, "error", err)
	} else if len(lokiPayload) > 0 {
		if result := backendDispatcher.Handoff(dispatcher.Output{
			Backend:     dispatcher.Loki,
			TraceID:     trace.TraceID,
			Payload:     lokiPayload,
			ContentType: "application/json",
			Priority:    1,
			Units:       len(result.Loki),
			ReceivedAt:  trace.ReceivedAt,
		}); result.Dropped {
			slog.WarnContext(ctx, "dropped Loki submission", "trace_id", trace.TraceID, "reason", result.Reason)
		}
	}
}

func flushAccumulator(ctx context.Context, accumulator *metrics.Accumulator, startTime uint64, backendDispatcher *dispatcher.Dispatcher) {
	endTime := wire.TimestampNow()
	normalized := accumulator.Flush(endTime)
	payload, err := wire.EncodeMetrics(normalized, startTime, endTime)
	if err != nil {
		slog.ErrorContext(ctx, "failed to encode accumulated metrics", "error", err)
		return
	}
	if len(payload) == 0 {
		return
	}
	if result := backendDispatcher.Handoff(dispatcher.Output{
		Backend:     dispatcher.Prometheus,
		TraceID:     "metrics",
		Payload:     payload,
		ContentType: "application/x-protobuf",
		Priority:    2,
		Units:       1,
		ReceivedAt:  time.Now(),
	}); result.Dropped {
		slog.WarnContext(ctx, "dropped accumulated OTel metrics submission", "reason", result.Reason)
	}
}
