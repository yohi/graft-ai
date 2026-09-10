# OTLP Metrics Temporality and Aggregation Window Notes

[日本語](otel-metrics-temporality.ja.md)

## Background

A review of `deploy/otel/alloy/internal/wire/metrics.go` identified the following requirements:

- Change event-level Sum and Histogram temporality from `CUMULATIVE` to `DELTA`.
- Aggregate samples by series within each `EncodeMetrics` reporting interval before emitting data points.
- Do not treat the Value and Count produced by `Normalize` for each span as cumulative state, and do not use individual span start/end timestamps as the shared reporting interval.
- Use a common timestamp for each reporting interval.

## Implementation

### 1. DELTA temporality with pre-aggregation

`EncodeMetrics` uses `aggregateSamples` to aggregate samples by name and labels. Both Sum and Histogram use `AGGREGATION_TEMPORALITY_DELTA`; there is no `CUMULATIVE` setting.

### 2. Double-counting fix

`aggregateSamples` previously initialized a new group's `Value` with `sample.Value` and then added the same sample again, doubling the first sample. New groups now initialize `Value` to `0`, and all samples are added through the same aggregation path.

### 3. Accumulator in `processLoop`

`processLoop` uses `metrics.Accumulator` and flushes it on the 30-second `metricsTicker` before calling `wire.EncodeMetrics`.

- `dispatchTrace` only adds each trace's `result.Metrics.Samples` to the accumulator.
- `flushAccumulator` flushes the accumulator and passes the flush start time as `startTime` and the current time as `endTime` to `EncodeMetrics`.
- Multiple traces for the same series are therefore aggregated into a shared 30-second reporting interval.
- The final accumulator is also flushed during shutdown when `queue.Items()` is closed.

### 4. Deriving `StartTimeUnixNano` and `TimeUnixNano`

The `EncodeMetrics` signature is `EncodeMetrics(normalized, startTime, endTime)`. `startTime` and `endTime` represent the accumulator reporting interval. They are derived by the accumulator rather than from the minimum and maximum timestamps of the input samples.

## Remaining Considerations

- The accumulator interval is currently fixed at 30 seconds, matching `metricsTicker`. It could be made configurable or aligned with a cron interval if needed.
- `Normalize` continues to produce raw samples per span. Aggregation is completed by the accumulator and `EncodeMetrics`.
- `_total` series remain monotonic counters (Sum), and duration remains a Histogram. They are not converted to gauges.

## Related Files

- `deploy/otel/alloy/internal/metrics/accumulator.go` — accumulator implementation
- `deploy/otel/alloy/internal/metrics/canonical.go` — adds `Count` and `BucketCounts` to `MetricSample`
- `deploy/otel/alloy/internal/wire/metrics.go` — `EncodeMetrics` signature and aggregation fix
- `deploy/otel/alloy/cmd/alloy-otel/pipeline.go` — accumulator integration
- `deploy/otel/alloy/internal/wire/metrics_test.go` — tests
