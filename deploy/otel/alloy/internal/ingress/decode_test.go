package ingress

import (
	"encoding/json"
	"math"
	"testing"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
)

func TestAnyValueJSON_handles_non_finite_double_values(t *testing.T) {
	tests := []struct {
		name  string
		value float64
	}{
		{name: "NaN", value: math.NaN()},
		{name: "positive infinity", value: math.Inf(1)},
		{name: "negative infinity", value: math.Inf(-1)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			value := &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: tt.value}}
			got := anyValueJSON(value)
			if string(got) != "null" {
				t.Fatalf("anyValueJSON(non-finite) = %q, want null", got)
			}
			if !json.Valid(got) {
				t.Fatalf("anyValueJSON(non-finite) returned invalid JSON: %q", got)
			}
		})
	}
}

func TestAnyValueJSON_preserves_finite_double_value(t *testing.T) {
	value := &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: 3.14}}
	got := anyValueJSON(value)
	var parsed float64
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("json.Unmarshal(%q): %v", got, err)
	}
	if parsed != 3.14 {
		t.Fatalf("parsed value = %v, want 3.14", parsed)
	}
}
