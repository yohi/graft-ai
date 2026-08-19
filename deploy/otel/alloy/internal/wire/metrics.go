package wire

import (
	"fmt"
	"math"
	"sort"
	"time"

	collectormetricspb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	metricspb "go.opentelemetry.io/proto/otlp/metrics/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/proto"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/metrics"
)

func EncodeMetrics(normalized metrics.NormalizedMetrics) ([]byte, error) {
	if len(normalized.Samples) == 0 {
		return nil, nil
	}
	output := &collectormetricspb.ExportMetricsServiceRequest{
		ResourceMetrics: []*metricspb.ResourceMetrics{{
			Resource: &resourcepb.Resource{},
			ScopeMetrics: []*metricspb.ScopeMetrics{{
				Metrics: make([]*metricspb.Metric, 0, len(normalized.Samples)),
			}},
		}},
	}
	for _, sample := range normalized.Samples {
		metric, err := metricProto(sample)
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

func metricProto(sample metrics.MetricSample) (*metricspb.Metric, error) {
	labels := make([]*commonpb.KeyValue, 0, len(sample.Labels))
	keys := make([]string, 0, len(sample.Labels))
	for key := range sample.Labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		labels = append(labels, &commonpb.KeyValue{Key: key, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: sample.Labels[key]}}})
	}
	timestamp := sample.TimestampUnixNano
	if timestamp == 0 {
		timestamp = uint64(time.Now().UnixNano())
	}
	if len(sample.Buckets) == 0 {
		return &metricspb.Metric{
			Name: sample.Name,
			Unit: "1",
			Data: &metricspb.Metric_Sum{Sum: &metricspb.Sum{
				IsMonotonic:            true,
				AggregationTemporality: metricspb.AggregationTemporality_AGGREGATION_TEMPORALITY_CUMULATIVE,
				DataPoints: []*metricspb.NumberDataPoint{{
					Attributes:   labels,
					TimeUnixNano: timestamp,
					Value:        &metricspb.NumberDataPoint_AsDouble{AsDouble: sample.Value},
				}},
			}},
		}, nil
	}
	if math.IsNaN(sample.Value) || math.IsInf(sample.Value, 0) {
		return nil, fmt.Errorf("metric %q has non-finite duration", sample.Name)
	}
	bucketCounts := make([]uint64, len(sample.Buckets))
	var cumulative uint64
	for index, boundary := range sample.Buckets {
		if sample.Value <= boundary {
			cumulative++
		}
		bucketCounts[index] = cumulative
	}
	return &metricspb.Metric{
		Name: sample.Name,
		Unit: "s",
		Data: &metricspb.Metric_Histogram{Histogram: &metricspb.Histogram{
			AggregationTemporality: metricspb.AggregationTemporality_AGGREGATION_TEMPORALITY_CUMULATIVE,
			DataPoints: []*metricspb.HistogramDataPoint{{
				Attributes:     labels,
				TimeUnixNano:   timestamp,
				Count:          cumulative,
				Sum:            &sample.Value,
				BucketCounts:   bucketCounts,
				ExplicitBounds: sample.Buckets[:len(sample.Buckets)-1],
			}},
		}},
	}, nil
}
