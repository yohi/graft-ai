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

const (
	metricsFlushInterval = time.Second
	maxMetricsDataPoints = 200
)

func processLoop(ctx context.Context, queue *ingress.IngressQueue, receiver *ingress.Receiver, traceSelector *selector.RequestSelector, sampler sampling.Sampler, backendDispatcher *dispatcher.Dispatcher, ratePPM uint32) {
	brancher := fanout.NewFanOut(sampler)
	ticker := time.NewTicker(selector.DefaultIdle / 2)
	defer ticker.Stop()
	metricsTicker := time.NewTicker(metricsFlushInterval)
	defer metricsTicker.Stop()
	accumulator := metrics.NewAccumulator()
	accumulatorStart := wire.TimestampNow()
	previousDispatcherMetrics := dispatcher.MetricsSnapshot{}
	previousIngressMetrics := ingress.MetricsSnapshot{}
	for {
		select {
		case envelope, ok := <-queue.Items():
			if !ok {
				accumulatorStart = dispatchTraces(ctx, brancher, backendDispatcher, traceSelector.FlushAll(), ratePPM, accumulator, accumulatorStart)
				currentDispatcherMetrics := backendDispatcher.Snapshot()
				currentIngressMetrics := receiver.Metrics()
				addDispatcherMetrics(accumulator, currentDispatcherMetrics, previousDispatcherMetrics)
				addIngressMetrics(accumulator, currentIngressMetrics, previousIngressMetrics)
				addIngressStateMetrics(accumulator, queue, receiver)
				flushAccumulator(ctx, accumulator, accumulatorStart, backendDispatcher)
				return
			}
			for _, span := range envelope.Spans {
				addSelectorEvictionMetrics(accumulator, traceSelector.AddAt(span, envelope.ReceivedAt))
			}
		case now := <-ticker.C:
			accumulatorStart = dispatchTraces(ctx, brancher, backendDispatcher, traceSelector.FlushIdle(now), ratePPM, accumulator, accumulatorStart)
		case <-metricsTicker.C:
			currentDispatcherMetrics := backendDispatcher.Snapshot()
			currentIngressMetrics := receiver.Metrics()
			addDispatcherMetrics(accumulator, currentDispatcherMetrics, previousDispatcherMetrics)
			addIngressMetrics(accumulator, currentIngressMetrics, previousIngressMetrics)
			addIngressStateMetrics(accumulator, queue, receiver)
			flushAccumulator(ctx, accumulator, accumulatorStart, backendDispatcher)
			accumulatorStart = wire.TimestampNow()
			previousDispatcherMetrics = currentDispatcherMetrics
			previousIngressMetrics = currentIngressMetrics
			logDispatcherMetrics(ctx, currentDispatcherMetrics)
		case <-ctx.Done():
			return
		}
	}
}

func addDispatcherMetrics(accumulator *metrics.Accumulator, current, previous dispatcher.MetricsSnapshot) {
	for backend, value := range current.Retries {
		addCounterMetric(accumulator, "otel_backend_export_retries_total", value, previous.Retries[backend], map[string]string{"backend": string(backend)})
	}
	for backend, value := range current.FailureStatusClasses {
		for statusClass, statusValue := range value {
			addCounterMetric(accumulator, "otel_backend_export_failures_total", statusValue, previous.FailureStatusClasses[backend][statusClass], map[string]string{"backend": string(backend), "status_class": statusClass})
		}
	}
	for backend, value := range current.Exhausted {
		addCounterMetric(accumulator, "otel_backend_export_exhausted_total", value, previous.Exhausted[backend], map[string]string{"backend": string(backend)})
	}
	for backend, value := range current.Drops {
		labels := map[string]string{"backend": string(backend), "signal": "export", "reason": "total"}
		addCounterMetric(accumulator, "otel_backend_queue_dropped_total", value, previous.Drops[backend], labels)
		for reason, reasonValue := range current.DropReasons[backend] {
			previousReasonValue := previous.DropReasons[backend][reason]
			addCounterMetric(accumulator, "otel_backend_queue_dropped_total", reasonValue, previousReasonValue, map[string]string{
				"backend": string(backend),
				"signal":  "export",
				"reason":  reason,
			})
		}
	}
	for backend, value := range current.QueueUtilization {
		addGaugeMetric(accumulator, "otel_backend_queue_utilization_ratio", value, map[string]string{"backend": string(backend)})
	}
	for backend, value := range current.QueueOldestAgeSeconds {
		addGaugeMetric(accumulator, "otel_backend_queue_oldest_age_seconds", value, map[string]string{"backend": string(backend)})
	}
}

func addIngressMetrics(accumulator *metrics.Accumulator, current, previous ingress.MetricsSnapshot) {
	addCounterMetric(accumulator, "otel_ingress_requests_total", current.Accepted, previous.Accepted, map[string]string{"status": "accepted"})
	addCounterMetric(accumulator, "otel_ingress_request_bytes_total", current.RequestBytes, previous.RequestBytes, nil)
	addCounterMetric(accumulator, "otel_ingress_rate_limited_total", current.RateLimited, previous.RateLimited, nil)
	addCounterMetric(accumulator, "otel_ingress_queue_dropped_total", current.CapacityDrops, previous.CapacityDrops, map[string]string{"reason": "capacity"})
	addCounterMetric(accumulator, "otel_ingress_queue_dropped_total", current.SizeDrops, previous.SizeDrops, map[string]string{"reason": "size"})
	for reason, value := range current.Rejections {
		addCounterMetric(accumulator, "otel_ingress_rejections_total", value, previous.Rejections[reason], map[string]string{"reason": reason})
	}
}

func addIngressStateMetrics(accumulator *metrics.Accumulator, queue *ingress.IngressQueue, receiver *ingress.Receiver) {
	addGaugeMetric(accumulator, "otel_ingress_active_requests", float64(receiver.ActiveRequests()), nil)
	addGaugeMetric(accumulator, "otel_ingress_queue_items", float64(queue.Len()), map[string]string{"queue": "dispatcher", "unit": "items"})
	addGaugeMetric(accumulator, "otel_ingress_queue_capacity", float64(queue.Capacity()), map[string]string{"queue": "dispatcher", "unit": "items"})
}

func addCounterMetric(accumulator *metrics.Accumulator, name string, current, previous uint64, labels map[string]string) {
	delta := current
	if current >= previous {
		delta = current - previous
	}
	if delta == 0 {
		return
	}
	_ = accumulator.Add(metrics.MetricSample{Name: name, Value: float64(delta), Labels: labels})
}

func addGaugeMetric(accumulator *metrics.Accumulator, name string, value float64, labels map[string]string) {
	_ = accumulator.Add(metrics.MetricSample{Name: name, Value: value, Labels: labels, Kind: metrics.Gauge})
}

func shouldFlushMetrics(accumulator *metrics.Accumulator) bool {
	return accumulator.DataPoints() >= maxMetricsDataPoints
}

func dispatchTraces(ctx context.Context, brancher fanout.FanOut, backendDispatcher *dispatcher.Dispatcher, traces []selector.Trace, ratePPM uint32, accumulator *metrics.Accumulator, accumulatorStart uint64) uint64 {
	for _, trace := range traces {
		dispatchTrace(ctx, brancher, backendDispatcher, trace, ratePPM, accumulator)
		if shouldFlushMetrics(accumulator) {
			flushAccumulator(ctx, accumulator, accumulatorStart, backendDispatcher)
			accumulatorStart = wire.TimestampNow()
		}
	}
	return accumulatorStart
}

func addSelectorEvictionMetrics(accumulator *metrics.Accumulator, evictions []selector.Eviction) {
	for _, eviction := range evictions {
		_ = accumulator.Add(metrics.MetricSample{
			Name:  "otel_backend_queue_dropped_total",
			Value: 1,
			Labels: map[string]string{
				"backend": "selector",
				"signal":  "trace",
				"reason":  eviction.Reason,
			},
		})
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
	if !backendDispatcher.HasBackend(dispatcher.Loki) {
		return
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
