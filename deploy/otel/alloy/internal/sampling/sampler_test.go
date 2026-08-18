package sampling

import "testing"

func TestSampler_matches_fixed_trace_decisions_without_float_rounding(t *testing.T) {
	sampler, err := NewSampler("graft-ai-otel-v1")
	if err != nil {
		t.Fatalf("new sampler: %v", err)
	}
	tests := []struct {
		traceID string
		ratePPM uint32
		want    bool
	}{
		{traceID: "00000000000000000000000000000001", ratePPM: 0, want: false},
		{traceID: "00000000000000000000000000000001", ratePPM: 500000, want: false},
		{traceID: "00000000000000000000000000000001", ratePPM: 1_000_000, want: true},
		{traceID: "ffffffffffffffffffffffffffffffff", ratePPM: 500000, want: true},
		{traceID: "11111111111111111111111111111111", ratePPM: 500000, want: false},
	}
	for _, tt := range tests {
		if got := sampler.Decide(tt.traceID, tt.ratePPM); got != tt.want {
			t.Fatalf("Decide(%s, %d) = %v, want %v", tt.traceID, tt.ratePPM, got, tt.want)
		}
	}
}

func TestSampler_rejects_invalid_rates_priority_overrides_and_trace_ids(t *testing.T) {
	if err := ValidateRatePPM(1_000_001); err == nil {
		t.Fatal("rate above one million ppm was accepted")
	}
	sampler, err := NewSampler("graft-ai-otel-v1")
	if err != nil {
		t.Fatalf("new sampler: %v", err)
	}
	priority := 1
	if _, err := sampler.DecideWithPriority("00000000000000000000000000000001", 500000, &priority); err == nil {
		t.Fatal("priority override was accepted")
	}
	if sampler.Decide("not-a-trace-id", 1_000_000) {
		t.Fatal("invalid trace ID was sampled")
	}
}

func TestParseRatePPM_uses_decimal_floor_without_float_conversion(t *testing.T) {
	tests := map[string]uint32{
		"0":         0,
		"0.000001":  1,
		"0.9999999": 999999,
		"0.5":       500000,
		"1":         1_000_000,
		"1.0000":    1_000_000,
	}
	for decimal, want := range tests {
		got, err := ParseRatePPM(decimal)
		if err != nil || got != want {
			t.Fatalf("ParseRatePPM(%q) = %d, %v; want %d", decimal, got, err, want)
		}
	}
	for _, invalid := range []string{"-0.1", "1.000001", "2", "", "0x1"} {
		if _, err := ParseRatePPM(invalid); err == nil {
			t.Fatalf("ParseRatePPM(%q) accepted invalid rate", invalid)
		}
	}
}
