package sampling

import (
	"crypto/sha256"
	"errors"
	"math/bits"
	"strings"
)

const MaxRatePPM uint32 = 1_000_000

type Sampler struct {
	seed string
}

func NewSampler(seed string) (Sampler, error) {
	if strings.TrimSpace(seed) == "" {
		return Sampler{}, errors.New("sampling: seed is empty")
	}
	return Sampler{seed: seed}, nil
}

func (s Sampler) Decide(traceID string, ratePPM uint32) bool {
	decision, err := s.DecideWithPriority(traceID, ratePPM, nil)
	return err == nil && decision
}

func (s Sampler) DecideWithPriority(traceID string, ratePPM uint32, priority *int) (bool, error) {
	if priority != nil {
		return false, errors.New("sampling: priority overrides are not supported")
	}
	if err := ValidateRatePPM(ratePPM); err != nil {
		return false, err
	}
	if !validTraceID(traceID) {
		return false, errors.New("sampling: trace ID must be lowercase 32-character hexadecimal")
	}
	hash := sha256.Sum256([]byte(traceID + s.seed))
	hash64 := uint64(hash[0])<<56 | uint64(hash[1])<<48 | uint64(hash[2])<<40 | uint64(hash[3])<<32 |
		uint64(hash[4])<<24 | uint64(hash[5])<<16 | uint64(hash[6])<<8 | uint64(hash[7])
	high, _ := bits.Mul64(hash64, uint64(MaxRatePPM))
	return high < uint64(ratePPM), nil
}

func ValidateRatePPM(ratePPM uint32) error {
	if ratePPM > MaxRatePPM {
		return errors.New("sampling: rate exceeds one million ppm")
	}
	return nil
}

func ParseRatePPM(decimal string) (uint32, error) {
	value := strings.TrimSpace(decimal)
	if value == "" {
		return 0, errors.New("sampling: decimal rate is empty")
	}
	parts := strings.Split(value, ".")
	if len(parts) > 2 || (parts[0] != "0" && parts[0] != "1") {
		return 0, errors.New("sampling: decimal rate must be between 0 and 1")
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	for _, character := range fraction {
		if character < '0' || character > '9' {
			return 0, errors.New("sampling: decimal rate contains a non-digit")
		}
	}
	if parts[0] == "1" && strings.Trim(fraction, "0") != "" {
		return 0, errors.New("sampling: decimal rate exceeds one")
	}
	if len(fraction) > 6 {
		fraction = fraction[:6]
	}
	for len(fraction) < 6 {
		fraction += "0"
	}
	ppm := uint32(0)
	for _, character := range fraction {
		ppm = ppm*10 + uint32(character-'0')
	}
	if parts[0] == "1" {
		ppm += MaxRatePPM
	}
	return ppm, nil
}

func validTraceID(traceID string) bool {
	if len(traceID) != 32 {
		return false
	}
	for _, character := range traceID {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
