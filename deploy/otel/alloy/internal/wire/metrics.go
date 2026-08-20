package wire

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	collectormetricspb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	metricspb "go.opentelemetry.io/proto/otlp/metrics/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/proto"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/metrics"
)

func EncodeMetrics(normalized metrics.NormalizedMetrics, startTime, endTime uint64) ([]byte, error) {
	if len(normalized.Samples) == 0 {
		return nil, nil
	}
	aggregated, err := aggregateSamples(normalized.Samples)
	if err != nil {
		return nil, err
	}
	output := &collectormetricspb.ExportMetricsServiceRequest{
		ResourceMetrics: []*metricspb.ResourceMetrics{{
			Resource: &resourcepb.Resource{},
			ScopeMetrics: []*metricspb.ScopeMetrics{{
				Metrics: make([]*metricspb.Metric, 0, len(aggregated)),
			}},
		}},
	}
	for _, sample := range aggregated {
		metric, err := metricProto(sample, startTime, endTime)
		if err != nil {
			return nil, err
		}
		output.ResourceMetrics[0].ScopeMetrics[0].Metrics = append(output.ResourceMetrics[0].ScopeMetrics[0].Metrics, metric)
	}
	payload, err := proto.Marshal(output)
	if err != nil {
		return nil, fmt.Errorf("marshal Prometheus payload: %w", err)
	}
	return payload, nil
}

type aggregatedSample struct {
	Name         string
	Labels       map[string]string
	Kind         metrics.MetricKind
	Buckets      []float64
	Value        float64
	Count        uint64
	BucketCounts []uint64
}

func aggregateSamples(samples []metrics.MetricSample) ([]aggregatedSample, error) {
	groups := make(map[string]*aggregatedSample)
	var order []string
	for _, sample := range samples {
		key := sampleKey(sample)
		group, ok := groups[key]
		if !ok {
			group = &aggregatedSample{
				Name:    sample.Name,
				Labels:  sample.Labels,
				Kind:    sample.Kind,
				Buckets: sample.Buckets,
			}
			groups[key] = group
			order = append(order, key)
		}
		if sample.Kind == metrics.Gauge {
			if math.IsNaN(sample.Value) || math.IsInf(sample.Value, 0) {
				return nil, fmt.Errorf("metric %q has non-finite gauge", sample.Name)
			}
			group.Value = sample.Value
			group.Count = 1
			continue
		}
		if len(sample.Buckets) == 0 {
			group.Value += sample.Value
			group.Count++
			continue
		}
		if math.IsNaN(sample.Value) || math.IsInf(sample.Value, 0) {
			return nil, fmt.Errorf("metric %q has non-finite duration", sample.Name)
		}
		group.Value += sample.Value
		count := sample.Count
		if count == 0 {
			count = 1
		}
		group.Count += count
		if len(group.BucketCounts) == 0 {
			group.BucketCounts = sample.BucketCounts
			continue
		}
		for index := range group.BucketCounts {
			group.BucketCounts[index] += sample.BucketCounts[index]
		}
	}

	result := make([]aggregatedSample, 0, len(groups))
	for _, key := range order {
		result = append(result, *groups[key])
	}
	return result, nil
}

func sampleKey(sample metrics.MetricSample) string {
	return sample.Name + "\x00" + string(rune(sample.Kind)) + "\x00" + labelsKey(sample.Labels)
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

func metricProto(sample aggregatedSample, startTime, endTime uint64) (*metricspb.Metric, error) {
	labels := make([]*commonpb.KeyValue, 0, len(sample.Labels))
	keys := make([]string, 0, len(sample.Labels))
	for key := range sample.Labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		labels = append(labels, &commonpb.KeyValue{Key: key, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: sample.Labels[key]}}})
	}
	if len(sample.Buckets) == 0 {
		if sample.Kind == metrics.Gauge {
			return &metricspb.Metric{
				Name: sample.Name,
				Unit: "1",
				Data: &metricspb.Metric_Gauge{Gauge: &metricspb.Gauge{
					DataPoints: []*metricspb.NumberDataPoint{{
						Attributes:   labels,
						TimeUnixNano: endTime,
						Value:        &metricspb.NumberDataPoint_AsDouble{AsDouble: sample.Value},
					}},
				}},
			}, nil
		}
		return &metricspb.Metric{
			Name: sample.Name,
			Unit: "1",
			Data: &metricspb.Metric_Sum{Sum: &metricspb.Sum{
				IsMonotonic:            true,
				AggregationTemporality: metricspb.AggregationTemporality_AGGREGATION_TEMPORALITY_DELTA,
				DataPoints: []*metricspb.NumberDataPoint{{
					Attributes:        labels,
					StartTimeUnixNano: startTime,
					TimeUnixNano:      endTime,
					Value:             &metricspb.NumberDataPoint_AsDouble{AsDouble: sample.Value},
				}},
			}},
		}, nil
	}

	bucketCounts := make([]uint64, len(sample.Buckets))
	copy(bucketCounts, sample.BucketCounts)
	sum := sample.Value
	return &metricspb.Metric{
		Name: sample.Name,
		Unit: "s",
		Data: &metricspb.Metric_Histogram{Histogram: &metricspb.Histogram{
			AggregationTemporality: metricspb.AggregationTemporality_AGGREGATION_TEMPORALITY_DELTA,
			DataPoints: []*metricspb.HistogramDataPoint{{
				Attributes:        labels,
				StartTimeUnixNano: startTime,
				TimeUnixNano:      endTime,
				Count:             sample.Count,
				Sum:               &sum,
				BucketCounts:      bucketCounts,
				ExplicitBounds:    sample.Buckets[:len(sample.Buckets)-1],
			}},
		}},
	}, nil
}

// TimestampNow returns the current time as Unix nanoseconds.
func TimestampNow() uint64 {
	return uint64(time.Now().UnixNano())
}
