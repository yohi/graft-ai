# Model Name Cleansing and Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cleanse and normalize model names across Logpush and OpenTelemetry pipelines in graft-ai to eliminate corrupted concatenated model labels (e.g. `kimi-k2.7-codemoonshotai/Kimi-K2.7-Code`) and enforce canonical lowercase model identifiers.

**Architecture:** Enhance `normalizeModelName` in `workers/src/transform.ts` with Cloudflare AI Gateway stream-concatenation detection, prefix cleaning, and lowercase canonicalization. Integrate this function into `workers/src/otel/spanlog.ts` for Loki logs and `workers/src/otel/otlp-json.ts` for Prometheus metrics.

**Tech Stack:** TypeScript (strict mode), Vitest, Node.js.

## Global Constraints

- Tech stack: TypeScript with strict settings (`workers/tsconfig.json`); use npm inside `workers/`.
- Universal data contract: Loki labels are strictly limited to `model`, `status_code`, `env`, `gateway` on every path that writes to Loki; never add high-cardinality labels.
- Verification gates: `make test`, `make typecheck`, `make fmt`, and `make validate` must pass.
- Secrets hygiene: Never hardcode or commit secrets or tokens.

---

### Task 1: Enhance `normalizeModelName` with Stream-Concatenation Cleansing and Unit Tests

**Files:**
- Modify: `workers/src/transform.ts:7-17`
- Test: `workers/tests/transform.test.ts:11-27`

**Interfaces:**
- Produces: `export function normalizeModelName(modelId: string | undefined | null): string`
  - Strips `@cf/` vendor prefix.
  - Cleanses concatenated strings like `<model><provider>/<model>` to canonical `<model>`.
  - Normalizes single-provider prefix `provider/model` to `model`.
  - Canonicalizes to lowercase.
  - Returns `""` if trimmed input is empty.

- [ ] **Step 1: Write the failing unit tests**

Update `workers/tests/transform.test.ts` to add tests for stream concatenation bug, casing, and provider prefix stripping:

```ts
  it("cleanses Cloudflare AI Gateway stream-concatenation bug", () => {
    expect(normalizeModelName("kimi-k2.7-codemoonshotai/Kimi-K2.7-Code")).toBe("kimi-k2.7-code");
    expect(normalizeModelName("kimi-k2.7-codemoonshotai/kimi-k2.7-code")).toBe("kimi-k2.7-code");
    expect(normalizeModelName("glm-5.2zai-org/glm-5.2")).toBe("glm-5.2");
  });

  it("strips standard provider prefix and normalizes to lowercase", () => {
    expect(normalizeModelName("moonshotai/Kimi-K2.7-Code")).toBe("kimi-k2.7-code");
    expect(normalizeModelName("openai/GPT-4o")).toBe("gpt-4o");
  });

  it("handles whitespace and casing", () => {
    expect(normalizeModelName("  GPT-4.1-2025-04-14  ")).toBe("gpt-4.1-2025-04-14");
    expect(normalizeModelName("   ")).toBe("");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix workers transform.test.ts`
Expected: FAIL with `kimi-k2.7-codemoonshotai/Kimi-K2.7-Code` returning original string instead of `kimi-k2.7-code`.

- [ ] **Step 3: Implement enhanced `normalizeModelName` in `workers/src/transform.ts`**

Update `workers/src/transform.ts`:

```ts
export function normalizeModelName(modelId: string | undefined | null): string {
  if (!modelId || typeof modelId !== "string") return "";
  let trimmed = modelId.trim();
  if (!trimmed) return "";

  if (!trimmed.includes("/")) {
    return trimmed.toLowerCase();
  }

  // 1. Cloudflare Workers AI @cf/ prefix: @cf/<vendor>/<model> -> <model>
  if (trimmed.startsWith("@cf/")) {
    const withoutPrefix = trimmed.slice(4);
    const slashIndex = withoutPrefix.indexOf("/");
    trimmed = slashIndex >= 0 ? withoutPrefix.slice(slashIndex + 1) : withoutPrefix;
    if (!trimmed.includes("/")) {
      return trimmed.toLowerCase();
    }
  }

  // 2. Cloudflare AI Gateway SSE stream concatenation bug:
  // Format: <request_model><provider_slug>/<upstream_model>
  // e.g. "kimi-k2.7-codemoonshotai/Kimi-K2.7-Code"
  const lastSlashIndex = trimmed.lastIndexOf("/");
  const left = trimmed.slice(0, lastSlashIndex);
  const right = trimmed.slice(lastSlashIndex + 1);

  const leftLower = left.toLowerCase();
  const rightLower = right.toLowerCase();

  if (
    leftLower.startsWith(rightLower) ||
    leftLower.endsWith(rightLower) ||
    leftLower.includes(rightLower) ||
    rightLower.includes(leftLower)
  ) {
    return rightLower;
  }

  // 3. Redundant single-provider prefix: <provider>/<model> -> <model>
  // e.g. "moonshotai/kimi-k2.7-code" -> "kimi-k2.7-code"
  if (trimmed.indexOf("/") === lastSlashIndex) {
    return rightLower;
  }

  return trimmed.toLowerCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix workers transform.test.ts`
Expected: PASS all tests in `transform.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add workers/src/transform.ts workers/tests/transform.test.ts
git commit -m "feat(transform): モデル名のストリーム結合バグ解消と正規化を実装"
```

---

### Task 2: Integrate `normalizeModelName` into OTel Spanlog Projection (Loki)

**Files:**
- Modify: `workers/src/otel/spanlog.ts:1-30,70-78`
- Test: `workers/tests/otel/spanlog.test.ts`

**Interfaces:**
- Consumes: `normalizeModelName` from `../transform`
- Produces: Normalized `model` label and field in `projectLokiRecord(span: RedactedSpan)`

- [ ] **Step 1: Write the failing test in `workers/tests/otel/spanlog.test.ts`**

Add a test case in `workers/tests/otel/spanlog.test.ts`:

```ts
  it("normalizes corrupted model name in Loki labels and payload line", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const span = redactSpan(firstSpan);
    const record = projectLokiRecord({
      ...span,
      attributes: {
        ...span.attributes,
        model: "kimi-k2.7-codemoonshotai/Kimi-K2.7-Code",
      },
    });

    expect(record).not.toBeNull();
    expect(record?.labels.model).toBe("kimi-k2.7-code");
    const line = JSON.parse(record?.line ?? "{}");
    expect(line.model).toBe("kimi-k2.7-code");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix workers spanlog.test.ts`
Expected: FAIL with `record?.labels.model` equal to `"kimi-k2.7-codemoonshotai/Kimi-K2.7-Code"` instead of `"kimi-k2.7-code"`.

- [ ] **Step 3: Update `workers/src/otel/spanlog.ts` to call `normalizeModelName`**

Import `normalizeModelName` from `../transform` and apply to `fields.model` and `canonicalLabels`:

```ts
import { normalizeModelName } from "../transform";
```

In `projectLokiRecord`:
```ts
    model: normalizeModelName(firstString(span, "model", "gen_ai.request.model")) || "unknown",
```

In `canonicalLabels`:
```ts
function canonicalLabels(span: RedactedSpan): Record<(typeof LOKI_LABEL_KEYS)[number], string> {
  return {
    model: normalizeModelName(firstString(span, "model", "gen_ai.request.model")) || "unknown",
    status_code:
      firstString(span, "status_code", "http.response.status_code") || span.statusCode || "unknown",
    env: firstString(span, "env") || "unknown",
    gateway: firstString(span, "gateway") || "unknown",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix workers spanlog.test.ts`
Expected: PASS all tests in `spanlog.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add workers/src/otel/spanlog.ts workers/tests/otel/spanlog.test.ts
git commit -m "feat(otel): Lokiログ投影時にモデル名を正規化"
```

---

### Task 3: Integrate `normalizeModelName` into OTel Metrics Generation (Prometheus)

**Files:**
- Modify: `workers/src/otel/otlp-json.ts:1-25,185-195`
- Test: `workers/tests/otel/otlp.test.ts`

**Interfaces:**
- Consumes: `normalizeModelName` from `../transform`
- Produces: Normalized `model` label in `toMetricSamples` and `encodeMetricsJson`

- [ ] **Step 1: Write the failing test in `workers/tests/otel/otlp.test.ts`**

Add a test case in `workers/tests/otel/otlp.test.ts`:

```ts
  it("normalizes corrupted model name in metric labels", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const span = redactSpan(firstSpan);
    const trace: SelectedTrace = {
      traceId: span.traceId,
      spans: [span],
      requestSpan: {
        ...span,
        attributes: {
          ...span.attributes,
          model: "kimi-k2.7-codemoonshotai/Kimi-K2.7-Code",
        },
      },
      sampled: true,
      synthetic: false,
    };
    const samples = toMetricSamples(trace);
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.labels.model).toBe("kimi-k2.7-code");
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix workers otlp.test.ts`
Expected: FAIL with `sample.labels.model` equal to `"kimi-k2.7-codemoonshotai/Kimi-K2.7-Code"` instead of `"kimi-k2.7-code"`.

- [ ] **Step 3: Update `workers/src/otel/otlp-json.ts` to call `normalizeModelName`**

Import `normalizeModelName` from `../transform`:
```ts
import { normalizeModelName } from "../transform";
```

In `metricLabels`:
```ts
function metricLabels(span: RedactedSpan): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  for (const key of METRIC_LABEL_KEYS) {
    const raw = stringAttribute(span, key);
    if (key === "model") {
      labels[key] = normalizeModelName(raw) || "unknown";
    } else {
      labels[key] = raw || "unknown";
    }
  }
  return labels;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix workers otlp.test.ts`
Expected: PASS all tests in `otlp.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add workers/src/otel/otlp-json.ts workers/tests/otel/otlp.test.ts
git commit -m "feat(otel): Prometheusメトリクス集計時にモデル名を正規化"
```

---

### Task 4: Full Repository Validation Gates

**Files:**
- No new files

- [ ] **Step 1: Run full test suite**

Run: `make test`
Expected: All unit and integration tests pass.

- [ ] **Step 2: Run typecheck**

Run: `make typecheck`
Expected: Zero TypeScript errors.

- [ ] **Step 3: Run formatting check**

Run: `make fmt`
Expected: Code formatting is consistent.

- [ ] **Step 4: Run repository validation**

Run: `make validate`
Expected: All validation gates exit with 0.
