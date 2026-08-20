package metrics

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// Accumulator buffers MetricSample values keyed by metric name + labels so that
// multiple traces in the same reporting interval can be aggregated into a single
// DELTA data point per series.
type Accumulator struct {
	groups     map[string]*accumulatedSeries
	order      []string
	dataPoints int
}

type accumulatedSeries struct {
	name         string
	labels       map[string]string
	kind         MetricKind
	buckets      []float64
	value        float64
	count        uint64
	bucketCounts []uint64
}

// NewAccumulator creates an empty Accumulator.
func NewAccumulator() *Accumulator {
	return &Accumulator{
		groups: make(map[string]*accumulatedSeries),
	}
}

// Add incorporates a MetricSample into the accumulator.
func (a *Accumulator) Add(sample MetricSample) error {
	key := sample.Name + "\x00" + string(rune(sample.Kind)) + "\x00" + labelsKey(sample.Labels)
	series, ok := a.groups[key]
	if !ok {
		series = &accumulatedSeries{
			name:    sample.Name,
			labels:  sample.Labels,
			kind:    sample.Kind,
			buckets: sample.Buckets,
		}
		a.groups[key] = series
		a.order = append(a.order, key)
	}

	if sample.Kind == Gauge {
		if !isFinite(sample.Value) {
			return fmt.Errorf("metric %q has non-finite gauge", sample.Name)
		}
		series.value = sample.Value
		series.count = 1
		a.dataPoints++
		return nil
	}

	if len(sample.Buckets) == 0 {
		series.value += sample.Value
		series.count++
		a.dataPoints++
		return nil
	}

	if !isFinite(sample.Value) {
		return fmt.Errorf("metric %q has non-finite duration", sample.Name)
	}
	series.value += sample.Value
	series.count++
	a.dataPoints++
	if len(series.bucketCounts) == 0 {
		series.bucketCounts = make([]uint64, len(sample.Buckets))
	}
	for index, boundary := range sample.Buckets {
		if sample.Value <= boundary {
			series.bucketCounts[index]++
			break
		}
	}
	return nil
}

// DataPoints returns the number of samples accumulated since the last flush.
func (a *Accumulator) DataPoints() int {
	if a == nil {
		return 0
	}
	return a.dataPoints
}

// Flush returns all accumulated series as NormalizedMetrics and resets the
// accumulator so the next reporting interval starts empty.
func (a *Accumulator) Flush(timestampUnixNano uint64) NormalizedMetrics {
	if a == nil {
		return NormalizedMetrics{}
	}
	result := NormalizedMetrics{Samples: make([]MetricSample, 0, len(a.order))}
	for _, key := range a.order {
		series := a.groups[key]
		result.Samples = append(result.Samples, MetricSample{
			Name:              series.name,
			Value:             series.value,
			Labels:            series.labels,
			Kind:              series.kind,
			Buckets:           series.buckets,
			BucketCounts:      series.bucketCounts,
			Count:             series.count,
			TimestampUnixNano: timestampUnixNano,
		})
	}
	a.groups = make(map[string]*accumulatedSeries)
	a.order = nil
	a.dataPoints = 0
	return result
}

func isFinite(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}

func labelsKey(labels map[string]string) string {
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var builder strings.Builder
	for _, key := range keys {
		builder.WriteString(key)
		builder.WriteByte(0)
		builder.WriteString(labels[key])
		builder.WriteByte(0)
	}
	return builder.String()
}
