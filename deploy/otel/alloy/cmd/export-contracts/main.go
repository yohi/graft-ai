package main

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/redaction"
	"github.com/yohi/graft-ai/deploy/otel/alloy/internal/spanlogs"
)

func main() {
	projector := spanlogs.NewProjector()
	reasons := []string{
		"redaction_failure",
		string(spanlogs.DropReasonNumericFieldInvalid),
		string(spanlogs.DropReasonLineSize),
		string(spanlogs.DropReasonLineSizeMetadata),
	}

	numericKeys := make([]string, 0, len(redaction.NumericAliases))
	for key := range redaction.NumericAliases {
		numericKeys = append(numericKeys, key)
	}
	sort.Strings(numericKeys)

	contract := map[string]any{
		"maxLineBytes":       spanlogs.MaxLineBytes,
		"allowlistedFields":  projector.AllowlistedFields(),
		"lokiLabels":         projector.LokiLabels(),
		"payloadDropReasons": reasons,
		"truncatedSuffix":    spanlogs.TruncatedSuffix(),
		"numericKeys":        numericKeys,
	}

	out, err := json.MarshalIndent(contract, "", "  ")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(out))
}
