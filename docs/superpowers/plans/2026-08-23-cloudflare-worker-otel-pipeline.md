# Cloudflare Worker OTel Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloudflare Tunnel and custom Alloy OTel route with a dedicated Cloudflare Worker that securely receives AI Gateway OTLP/JSON and durably exports compatible Tempo, Loki, and Prometheus signals to Grafana Cloud.

**Architecture:** A public `workers.dev` OTel Worker authenticates and validates an OTLP/JSON request, deterministically redacts it, and persists only the redacted canonical envelope in R2. Queues carry R2 references, trace-keyed Durable Objects select and sample request spans, a metrics Durable Object batches DELTA metrics, and isolated backend consumers export JSON payloads to Grafana with Queue retry and DLQ recovery.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers, Queues, R2, SQLite-backed Durable Objects, Wrangler 4, `@cloudflare/vitest-pool-workers`, Terraform Cloudflare provider 5, Grafana Cloud OTLP/HTTP and Loki HTTP APIs.

## Global Constraints

- Add a dedicated Worker. Do not add OTel handling to `workers/src/index.ts`, which remains the encrypted Logpush Worker.
- The AI Gateway exporter and all Grafana OTLP requests use `application/json`. Do not add a protobuf runtime dependency.
- Grafana Cloud documents OTLP/JSON as appropriate for low-volume use. Cap every emitted Tempo or metrics JSON document at `4_000_000` UTF-8 bytes, below the documented 5 MB trace ingestion limit.
- The only accepted ingress is `POST /v1/traces` with `Content-Type: application/json` and `Content-Encoding` absent or `identity`.
- Keep the existing receiver limits where the Workers runtime can enforce them: 8 MiB body, 30 second body-read deadline, 100 active requests, 1,000 durable ingress reservations, token bucket capacity 20, refill 2 per second, and `Retry-After` of at least one second.
- A public Worker has no Tunnel peer CIDR to validate. Bearer authentication is the trust boundary; use Cloudflare-provided `CF-Connecting-IP` only for HMAC-hashed rate-limit buckets, and ignore `X-Forwarded-For` and `True-Client-IP`.
- Redact before any R2 write, Queue send, Durable Object request, log, or Grafana request. Do not persist raw headers, raw OTLP bodies, prompt/completion text before redaction, or credentials.
- Preserve all existing signal contracts: request-span selection, `graft-ai-otel-v1` SHA-256 sampling, unsampled RED metrics, sampled Tempo/Loki output, canonical metric names, and exactly four Loki labels: `model`, `status_code`, `env`, `gateway`.
- Use at-least-once Queue semantics. Every ingress and export operation needs a stable ID, Durable Object idempotency, and a 25-hour deduplication tombstone. Do not claim exactly-once delivery.
- R2 stores only redacted JSON below `otel/`; delete successful objects eagerly and enforce a seven-day lifecycle rule so DLQ records remain replayable without exceeding the 14-day payload-retention boundary.
- Terraform owns Queue, DLQ, R2 bucket, and R2 lifecycle resources. `wrangler.otel.jsonc` is the sole owner of Worker queue consumers and Durable Object lifecycle; do not add `cloudflare_queue_consumer` resources.
- Use `workers.dev` for the first deployment. Do not add a custom route or Zone DNS dependency while the current API token cannot manage Zone DNS.
- Secrets are Wrangler secrets only: `OTEL_INGEST_TOKEN`, `OTEL_RATE_LIMIT_HMAC_KEY`, `GRAFANA_CLOUD_OTLP_TRACES_URL`, `GRAFANA_CLOUD_OTLP_METRICS_URL`, `GRAFANA_CLOUD_OTLP_AUTHORIZATION`, `GRAFANA_CLOUD_LOKI_URL`, and `GRAFANA_CLOUD_LOKI_AUTHORIZATION`.
- Do not modify agent configuration files. Do not commit secrets, generated `.dev.vars`, Terraform state, credentials, or endpoint Authorization values.

---

## File Structure

| File                                           | Change               | Responsibility                                                                                                            |
| ---------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `workers/wrangler.otel.jsonc`                  | Create               | Dedicated Worker name, Queue producers/consumers, R2 binding, SQLite Durable Object exports, non-secret runtime settings. |
| `workers/vitest.otel.config.ts`                | Create               | Workers Vitest pool configured only with `wrangler.otel.jsonc`.                                                           |
| `workers/src/otel.ts`                          | Create               | Worker `fetch` and `queue` entrypoint; exports the four Durable Object classes.                                           |
| `workers/src/otel/contracts.ts`                | Create               | Immutable Worker constants for limits, queue names, labels, backend names, and status reasons.                            |
| `workers/src/otel/types.ts`                    | Create               | Strict OTLP JSON, canonical span, Queue pointer, backend job, and environment types.                                      |
| `workers/src/otel/otlp.ts`                     | Create               | OTLP JSON parsing, ID validation, attribute alias normalization, and safe canonical projection.                           |
| `workers/src/otel/redaction.ts`                | Create               | Credential/payload redaction and fail-closed payload drop handling.                                                       |
| `workers/src/otel/selection.ts`                | Create               | Request-span selection and deterministic trace sampling.                                                                  |
| `workers/src/otel/spanlog.ts`                  | Create               | Loki record projection and 262,144-byte UTF-8-safe truncation/drop behavior.                                              |
| `workers/src/otel/otlp-json.ts`                | Create               | Redacted Tempo and DELTA Prometheus OTLP/JSON encoders.                                                                   |
| `workers/src/otel/rate-limit.ts`               | Create               | Source-keyed token-bucket Durable Object.                                                                                 |
| `workers/src/otel/ledger.ts`                   | Create               | Global ingress reservation, export claim/completion, and 25-hour tombstone Durable Object.                                |
| `workers/src/otel/trace-aggregate.ts`          | Create               | Trace-keyed idle aggregation Durable Object and sampled signal fan-out.                                                   |
| `workers/src/otel/metrics-aggregate.ts`        | Create               | Singleton 30-second/200-sample metrics aggregation Durable Object.                                                        |
| `workers/src/otel/storage.ts`                  | Create               | Redacted R2 object serialization, SHA-256 verification, and delete-after-success helpers.                                 |
| `workers/src/otel/queue.ts`                    | Create               | Ingress Queue routing, output Queue routing, manual acknowledgement, and retry policy.                                    |
| `workers/src/otel/exporter.ts`                 | Create               | Grafana HTTP export, retry classification, safe failure records, and DLQ behavior.                                        |
| `workers/tests/otel/*.test.ts`                 | Create               | Unit, Durable Object, Queue, and end-to-end coverage for the new route.                                                   |
| `workers/tests/otel-worker-contracts.test.mjs` | Create               | Static Wrangler/configuration and no-secret regression checks.                                                            |
| `workers/package.json`                         | Modify               | Add separate OTel test and typecheck scripts without changing existing Worker scripts.                                    |
| `workers/tsconfig.json`                        | Modify               | Include the OTel test/config sources while retaining strict options.                                                      |
| `terraform/otel.tf`                            | Create               | Account-level Queues, DLQs, R2 bucket, and seven-day R2 lifecycle rule.                                                   |
| `terraform/variables.tf`                       | Modify               | Add non-secret OTel Worker and bucket naming inputs.                                                                      |
| `terraform/outputs.tf`                         | Modify               | Expose non-secret Queue, bucket, and Worker URL inputs for operators.                                                     |
| `terraform/terraform.tfvars.example`           | Modify               | Document non-secret OTel names only.                                                                                      |
| `Makefile`                                     | Modify               | Add Worker-specific validate/test/deploy targets, then replace Alloy targets only after cutover.                          |
| `.github/workflows/ci.yml`                     | Modify               | Run the OTel Worker tests, typecheck, and Terraform validation.                                                           |
| `.github/workflows/deploy.yml`                 | Modify               | Apply account resources, synchronize OTel Worker secrets, then deploy the Worker.                                         |
| `scripts/verify-otel-worker-config.mjs`        | Create               | Validate the Worker bindings, JSON-only ingress, queue topology, and forbidden inline secrets.                            |
| `scripts/otel-worker-smoke.mjs`                | Create               | Submit a synthetic redacted OTLP/JSON request to a configured Worker endpoint.                                            |
| `docs/cloudflare-worker-ai-gateway-otel.md`    | Create               | Worker deployment, rollback, DLQ, Grafana, and retirement runbook.                                                        |
| `README.md`, `README.ja.md`                    | Modify               | Describe the Worker OTel route while the legacy route remains available for rollback.                                     |
| `docs/free-tier-ai-gateway-otel.md`            | Modify after cutover | Replace Tunnel/Alloy operational instructions with the Worker route.                                                      |

## Compatibility Map

| Existing Alloy behavior                                                     | Worker replacement                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Receiver.ServeHTTP` validates path, auth, body, and rate limit.            | `handleIngress()` plus `OtelRateLimit` and `OtelLedger` Durable Objects.                        |
| `decodeSpans` normalizes Cloudflare semantic convention aliases.            | `parseOtlpJson()` and `canonicalizeAttributes()`.                                               |
| `Redactor.Redact` protects payloads before queue handoff.                   | `redactSpan()` before `putJsonObject()` and all DO/Queue calls.                                 |
| `RequestSelector` flushes after one idle second.                            | `TraceAggregate.alarm()` with a one-second alarm and deterministic selection tuple.             |
| `Sampler` uses `SHA256(traceID + "graft-ai-otel-v1")`.                      | `shouldSampleTrace()` with integer ppm arithmetic and the existing fixtures.                    |
| `EncodeTempo`, `EncodeLoki`, `EncodeMetrics` create three signal forms.     | OTLP/JSON trace and metrics encoders plus the existing Loki JSON shape.                         |
| Dispatcher retries three total attempts and reports logical health metrics. | Per-message Queue retry with `attempts < 3`, backend-specific DLQs, and identical metric names. |

## Task 1: Provision Isolated Worker Resources and Test Harness

**Files:**

- Create: `terraform/otel.tf`
- Modify: `terraform/outputs.tf`
- Create: `workers/wrangler.otel.jsonc`
- Create: `workers/vitest.otel.config.ts`
- Create: `workers/tests/otel-worker-contracts.test.mjs`
- Modify: `workers/package.json`
- Modify: `workers/tsconfig.json`
- Modify: `Makefile`

**Interfaces:**

- Produces Queue names: `graft-ai-aig-otel-{ingress,tempo,loki,prometheus}-v1` and one matching `-dlq-v1` Queue for each source Queue.
- Produces R2 bucket name: `graft-ai-aig-otel-v1`.
- Produces `OtelEnv` bindings: `OTEL_INGRESS_QUEUE`, `OTEL_TEMPO_QUEUE`, `OTEL_LOKI_QUEUE`, `OTEL_PROMETHEUS_QUEUE`, `OTEL_OBJECTS`, `OTEL_RATE_LIMIT`, `OTEL_LEDGER`, `OTEL_TRACE_AGGREGATE`, and `OTEL_METRICS_AGGREGATE`.
- Consumes the existing root Cloudflare Terraform workspace and the existing `workers/` npm workspace.

- [ ] **Step 1: Add the static configuration test before creating resources**

Create `workers/tests/otel-worker-contracts.test.mjs`. Parse JSONC with the existing `scripts/parse-jsonc.mjs` helper and assert the isolated Worker contract:

```js
assert.equal(config.name, "graft-ai-aig-otel");
assert.equal(config.main, "src/otel.ts");
assert.equal(config.workers_dev, true);
assert.equal(config.queues.producers.length, 4);
assert.equal(config.queues.consumers.length, 4);
assert.equal(config.r2_buckets[0].binding, "OTEL_OBJECTS");
assert.deepEqual(Object.keys(config.exports).sort(), [
  "OtelLedger",
  "OtelMetricsAggregate",
  "OtelRateLimit",
  "TraceAggregate",
]);
assert.doesNotMatch(
  JSON.stringify(config),
  /Authorization:|OTEL_INGEST_TOKEN\s*:/,
);
```

- [ ] **Step 2: Run the new static test and confirm it fails**

Run:

```bash
node --test workers/tests/otel-worker-contracts.test.mjs
```

Expected: FAIL because `wrangler.otel.jsonc` does not exist.

- [ ] **Step 3: Add Terraform-owned Queue and R2 resources**

Create `terraform/otel.tf`. Use `for_each` so all four source queues have identical one-day retention, while Wrangler owns their consumers:

```hcl
locals {
  otel_worker_name = "graft-ai-aig-otel"
  otel_queue_names = {
    ingress    = "${local.otel_worker_name}-ingress-v1"
    tempo      = "${local.otel_worker_name}-tempo-v1"
    loki       = "${local.otel_worker_name}-loki-v1"
    prometheus = "${local.otel_worker_name}-prometheus-v1"
  }
  otel_dlq_names = {
    ingress    = "${local.otel_worker_name}-ingress-dlq-v1"
    tempo      = "${local.otel_worker_name}-tempo-dlq-v1"
    loki       = "${local.otel_worker_name}-loki-dlq-v1"
    prometheus = "${local.otel_worker_name}-prometheus-dlq-v1"
  }
}

resource "cloudflare_queue" "otel" {
  for_each   = local.otel_queue_names
  account_id = var.cloudflare_account_id
  queue_name = each.value
  settings = {
    message_retention_period = 86400
  }
}

resource "cloudflare_queue" "otel_dlq" {
  for_each   = local.otel_dlq_names
  account_id = var.cloudflare_account_id
  queue_name = each.value
  settings = {
    message_retention_period = 345600
  }
}
```

Add `cloudflare_r2_bucket.otel` and `cloudflare_r2_bucket_lifecycle.otel` in the same file. Scope its enabled delete rule to `otel/` with `max_age = 604800` and `type = "Age"`. Do not add a public R2 domain, CORS rule, or event notification.

Add `otel_worker_url` to `outputs.tf`, computed from the fixed Worker name and the existing `workers_subdomain` input. Keep the Worker, Queue, and R2 names fixed in Terraform and Wrangler so a Terraform variable cannot silently diverge from binding configuration.

- [ ] **Step 4: Configure a separate Worker with declarative SQLite Durable Objects**

Create `workers/wrangler.otel.jsonc` using `exports`, not legacy `migrations`. The Queue consumer settings below are the only consumer configuration source of truth:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "graft-ai-aig-otel",
  "main": "src/otel.ts",
  "compatibility_date": "2026-08-23",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "observability": { "enabled": true, "head_sampling_rate": 0.1 },
  "vars": {
    "GATEWAY_NAME": "main",
    "ENV_LABEL": "prod",
    "OTEL_SAMPLING_RATE": "1",
    "OTEL_GRAFANA_CLOUD_LOGS_RETENTION": "14d",
  },
  "queues": {
    "producers": [
      {
        "binding": "OTEL_INGRESS_QUEUE",
        "queue": "graft-ai-aig-otel-ingress-v1",
      },
      { "binding": "OTEL_TEMPO_QUEUE", "queue": "graft-ai-aig-otel-tempo-v1" },
      { "binding": "OTEL_LOKI_QUEUE", "queue": "graft-ai-aig-otel-loki-v1" },
      {
        "binding": "OTEL_PROMETHEUS_QUEUE",
        "queue": "graft-ai-aig-otel-prometheus-v1",
      },
    ],
    "consumers": [
      {
        "queue": "graft-ai-aig-otel-ingress-v1",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 2,
        "retry_delay": 1,
        "max_concurrency": 10,
        "dead_letter_queue": "graft-ai-aig-otel-ingress-dlq-v1",
      },
      {
        "queue": "graft-ai-aig-otel-tempo-v1",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 2,
        "retry_delay": 1,
        "max_concurrency": 10,
        "dead_letter_queue": "graft-ai-aig-otel-tempo-dlq-v1",
      },
      {
        "queue": "graft-ai-aig-otel-loki-v1",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 2,
        "retry_delay": 1,
        "max_concurrency": 10,
        "dead_letter_queue": "graft-ai-aig-otel-loki-dlq-v1",
      },
      {
        "queue": "graft-ai-aig-otel-prometheus-v1",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 2,
        "retry_delay": 1,
        "max_concurrency": 10,
        "dead_letter_queue": "graft-ai-aig-otel-prometheus-dlq-v1",
      },
    ],
  },
  "r2_buckets": [
    { "binding": "OTEL_OBJECTS", "bucket_name": "graft-ai-aig-otel-v1" },
  ],
  "durable_objects": {
    "bindings": [
      { "name": "OTEL_RATE_LIMIT", "class_name": "OtelRateLimit" },
      { "name": "OTEL_LEDGER", "class_name": "OtelLedger" },
      { "name": "OTEL_TRACE_AGGREGATE", "class_name": "TraceAggregate" },
      {
        "name": "OTEL_METRICS_AGGREGATE",
        "class_name": "OtelMetricsAggregate",
      },
    ],
  },
  "exports": {
    "OtelRateLimit": { "type": "durable-object", "storage": "sqlite" },
    "OtelLedger": { "type": "durable-object", "storage": "sqlite" },
    "TraceAggregate": { "type": "durable-object", "storage": "sqlite" },
    "OtelMetricsAggregate": { "type": "durable-object", "storage": "sqlite" },
  },
}
```

The four source Queues use two retries after their first delivery, for at most three total export attempts. Each consumer has a matching independent DLQ.

- [ ] **Step 5: Isolate OTel tests and commands**

Create `workers/vitest.otel.config.ts` with the same `cloudflareTest()` plugin as `vitest.config.ts`, set `wrangler.configPath` to `./wrangler.otel.jsonc`, and restrict `test.include` to `tests/otel/**/*.test.ts`.

Add these npm scripts:

```json
"test:otel": "vitest run --config vitest.otel.config.ts",
"typecheck:otel": "tsc --noEmit",
"validate:otel": "wrangler deploy --dry-run --config wrangler.otel.jsonc"
```

Add `otel-worker-test`, `otel-worker-validate`, and `deploy-otel-worker` Make targets. During coexistence, `make test` must run both `npm test` and `npm run test:otel`; it must retain the legacy Alloy test targets until Task 8.

- [ ] **Step 6: Verify infrastructure and configuration**

Run:

```bash
terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false
terraform -chdir=terraform validate
node --test workers/tests/otel-worker-contracts.test.mjs
cd workers && npm run validate:otel
```

Expected: Terraform validates the Queue/R2 resources; Wrangler validates the bindings and SQLite exports without deploying; the static test passes.

- [ ] **Step 7: Create a commit only if the user explicitly requests one**

Stage only the files in this task and use a Conventional Commit message such as `feat(otel): Worker用の永続リソースを追加`.

## Task 2: Port the Pure OTLP, Redaction, Selection, and Sampling Contracts

**Files:**

- Create: `workers/src/otel/contracts.ts`
- Create: `workers/src/otel/types.ts`
- Create: `workers/src/otel/otlp.ts`
- Create: `workers/src/otel/redaction.ts`
- Create: `workers/src/otel/selection.ts`
- Create: `workers/src/otel/spanlog.ts`
- Create: `workers/src/otel/otlp-json.ts`
- Create: `workers/tests/otel/otlp.test.ts`
- Create: `workers/tests/otel/redaction.test.ts`
- Create: `workers/tests/otel/selection.test.ts`
- Create: `workers/tests/otel/spanlog.test.ts`
- Create: `workers/tests/otel/otlp-json.test.ts`

**Interfaces:**

- Consumes: `deploy/otel/contracts/contracts.json` and `deploy/otel/contracts/sampling-fixtures.json` as the coexistence reference contract.
- Produces `parseOtlpJson(body: unknown): readonly CanonicalSpan[]`, `redactSpan(span: CanonicalSpan): RedactedSpan`, `selectRequestSpan(spans: readonly RedactedSpan[]): SelectedTrace`, `shouldSampleTrace(traceId: string, rate: string): boolean`, `toMetricSamples(trace: SelectedTrace): readonly MetricSample[]`, `toTempoTrace(trace: SelectedTrace, sampled: boolean): readonly RedactedSpan[]`, `toLokiRecords(trace: SelectedTrace, sampled: boolean): readonly LokiRecord[]`, `projectLokiRecord(span: RedactedSpan): LokiRecord | null`, `encodeTempoJson(trace: SelectedTrace): Uint8Array`, and `encodeMetricsJson(samples: readonly MetricSample[], window: MetricWindow): Uint8Array`.
- Guarantees: no parser result contains unredacted payload text after `redactSpan()`, and all exported JSON is deterministic for equal input.

- [ ] **Step 1: Add failing algorithm tests from the existing contracts**

Create tests that import `contracts.ts` and load the existing JSON fixtures. Include these exact cases:

```ts
it("accepts only OTLP JSON with valid 16-byte trace and 8-byte span IDs", () => {
  expect(() => parseOtlpJson(validOtlpJson)).not.toThrow();
  expect(() => parseOtlpJson({ resourceSpans: [] })).toThrow(/span/i);
  expect(() => parseOtlpJson(invalidTraceIdOtlpJson)).toThrow(/trace ID/i);
});

it("keeps metrics for sampled-out traces", () => {
  const selected = selectRequestSpan(redactedTrace);
  expect(shouldSampleTrace(selected.traceId, "0.5")).toBe(false);
  expect(toMetricSamples(selected)).toHaveLength(3);
  expect(toTempoTrace(selected, false)).toEqual([]);
  expect(toLokiRecords(selected, false)).toEqual([]);
});
```

Add fixture cases for bearer, Basic, API-key, nested `token`/`password` keys, malformed JSON payload, depth 65, invalid numeric fields, 262,144-byte log lines, metadata-only overflow, and every trace/rate pair in `sampling-fixtures.json`.

- [ ] **Step 2: Run the focused suites and confirm they fail**

Run:

```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/otlp.test.ts tests/otel/redaction.test.ts tests/otel/selection.test.ts tests/otel/spanlog.test.ts tests/otel/otlp-json.test.ts
```

Expected: FAIL because the Worker OTel modules do not exist.

- [ ] **Step 3: Define strict types and immutable shared constants**

In `contracts.ts`, define the values copied from the current contract instead of magic numbers:

```ts
export const MAX_INGRESS_BYTES = 8 * 1024 * 1024;
export const MAX_GRAFANA_OTLP_BYTES = 4_000_000;
export const MAX_LOKI_LINE_BYTES = 262_144;
export const LOKI_LABEL_KEYS = [
  "model",
  "status_code",
  "env",
  "gateway",
] as const;
export const METRIC_LABEL_KEYS = [
  "model",
  "provider",
  "status_code",
  "env",
  "gateway",
] as const;
export const SAMPLING_SEED = "graft-ai-otel-v1";
export const DURATION_BUCKETS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  Infinity,
] as const;
```

Model nanosecond timestamps and all OTLP 64-bit counters as validated decimal strings or `bigint`; do not convert trace IDs, nanoseconds, counts, or the sampling hash through `number`.

- [ ] **Step 4: Parse and canonicalize only the required OTLP JSON shape**

`parseOtlpJson()` must traverse `resourceSpans[].scopeSpans[].spans[]`, reject an empty valid-span set, normalize lowercase hexadecimal trace/span IDs, and retain only the resource/span attributes needed by the legacy allowlists.

Use these canonical alias orders:

```ts
const ATTRIBUTE_ALIASES = {
  model: ["model", "gen_ai.request.model"],
  provider: [
    "provider",
    "gen_ai.model.provider",
    "gen_ai.provider.name",
    "gen_ai.system",
  ],
  request_id: ["request_id", "cf-aig-request-id"],
  status_code: ["status_code", "http.response.status_code"],
  input_tokens: ["input_tokens", "gen_ai.usage.input_tokens"],
  output_tokens: ["output_tokens", "gen_ai.usage.output_tokens"],
  total_tokens: ["total_tokens", "gen_ai.usage.total_tokens"],
  cost_usd: ["cost_usd", "gen_ai.usage.cost"],
} as const;
```

Treat missing `model`, `provider`, `gateway`, and `env` as `"unknown"`; do not synthesize a request ID.

- [ ] **Step 5: Port fail-closed redaction and serialization limits**

Apply redaction before any output projection. For `gen_ai.prompt_json`, `gen_ai.completion_json`, and `cf-aig-metadata`, recursively replace credential values with `[REDACTED]`. If structured parsing, depth validation, or replacement fails, remove only that payload field and set:

```ts
payloadTruncated: false,
payloadDropped: true,
payloadDropReason: "redaction_failure",
```

`projectLokiRecord()` must JSON serialize first, count UTF-8 bytes with `TextEncoder`, split available payload budget 50:50 when prompt and completion exist, append `[TRUNCATED]` within each byte budget without splitting a Unicode code point, then reserialize. Drop the record only if metadata alone exceeds the limit, with reason `line_size_metadata`.

- [ ] **Step 6: Port selection, sampling, and OTLP/JSON encoders**

Select a request span only when it is a server span and either has no parent span ID or has a request ID. Sort candidates by `startTimeUnixNano`, then `spanId`; mark every span `graft_ai.request_span=false` before setting the selected span to `true`.

Implement the sampling comparison without floating point:

```ts
const digest = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(`${traceId}${SAMPLING_SEED}`),
);
const hash64 = BigInt(
  `0x${Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
);
return hash64 * 1_000_000n < BigInt(ratePpm) * (1n << 64n);
```

Encode Tempo as OTLP JSON `resourceSpans`, retaining only the existing Tempo metadata allowlist. Encode metrics as OTLP JSON DELTA sums and histograms, with a common 30-second reporting window and string-form 64-bit counts. Encode Loki as `{"streams":[...]}` with exactly the four canonical labels.

- [ ] **Step 7: Run focused tests, typecheck, and format**

Run:

```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/otlp.test.ts tests/otel/redaction.test.ts tests/otel/selection.test.ts tests/otel/spanlog.test.ts tests/otel/otlp-json.test.ts
cd workers && npm run typecheck:otel
cd workers && npx prettier --write src/otel tests/otel
```

Expected: all fixture decisions match the Go reference, payloads are redacted before projection, metrics are DELTA, and no Loki record has extra labels.

- [ ] **Step 8: Create a commit only if the user explicitly requests one**

Stage only Task 2 files and use a message such as `feat(otel): WorkerへOTLP処理契約を移植`.

## Task 3: Add Durable Coordination for Rate Limits, Trace Aggregation, Metrics, and Idempotency

**Files:**

- Create: `workers/src/otel/rate-limit.ts`
- Create: `workers/src/otel/ledger.ts`
- Create: `workers/src/otel/trace-aggregate.ts`
- Create: `workers/src/otel/metrics-aggregate.ts`
- Create: `workers/tests/otel/rate-limit.test.ts`
- Create: `workers/tests/otel/trace-aggregate.test.ts`
- Create: `workers/tests/otel/metrics-aggregate.test.ts`

**Interfaces:**

- `OtelRateLimit.take(sourceHash: string, nowMs: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>`.
- `OtelLedger.reserveIngress(ingressId: string, nowMs: number): Promise<"accepted" | "capacity">` and `claimExport(jobId: string): Promise<"claimed" | "complete">`.
- `TraceAggregate.fetch()` accepts `POST /ingest` with `{ ingressId, receivedAtMs, spans }` and flushes one second after the final observed span.
- `OtelMetricsAggregate.fetch()` accepts `POST /append` with a deduplicated `MetricSample[]`, flushes after 30 seconds or 200 samples, and emits a Prometheus Queue pointer.

- [ ] **Step 1: Add failing Durable Object tests**

Use `runInDurableObject`, `runDurableObjectAlarm`, and `evictDurableObject` from `cloudflare:test`. Cover stable source HMAC buckets, 20-token capacity, a one-second idle alarm, a duplicate ingress ID after eviction, a 25-hour completion tombstone, the deterministic request-span tie-break, metrics flush at 200 samples, and a 30-second metrics alarm.

```ts
it("does not count the same ingress twice after a queue retry", async () => {
  const trace = env.OTEL_TRACE_AGGREGATE.getByName(traceId);
  await trace.fetch("https://trace/ingest", {
    method: "POST",
    body: JSON.stringify(input),
  });
  await evictDurableObject(trace);
  await trace.fetch("https://trace/ingest", {
    method: "POST",
    body: JSON.stringify(input),
  });
  await runDurableObjectAlarm(trace);
  expect(await drainMetricQueue()).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused Durable Object suites and confirm they fail**

Run:

```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/rate-limit.test.ts tests/otel/trace-aggregate.test.ts tests/otel/metrics-aggregate.test.ts
```

Expected: FAIL because the Durable Object classes do not exist.

- [ ] **Step 3: Implement the rate limiter without persisting source IPs**

Use `HMAC-SHA-256(OTEL_RATE_LIMIT_HMAC_KEY, "otel-ingress-source-v1\\0" + canonicalSourceIp)` as the `idFromName()` input. Store only token count and last refill timestamp in the object. Canonicalize IPv4/IPv6, use `unknown` only when `CF-Connecting-IP` is absent/invalid, and never store or label the raw IP.

Return `429` with `Retry-After: "1"` or the ceiling of the next token availability. Do not add client-controlled forwarding headers to the key.

- [ ] **Step 4: Implement the ledger and trace state with SQLite-backed idempotency**

`OtelLedger` stores ingress reservations and export states keyed by UUID-like IDs only. It must:

- reserve at most 1,000 pending ingress IDs;
- return `capacity` without enqueueing when full, while ingress still returns `200` with `X-OTel-Drop-Reason: capacity`;
- expire abandoned reservations and completed export tombstones after 25 hours through its alarm;
- record a job as complete before R2 deletion so a duplicate Queue delivery acknowledges without a second Grafana POST.

`TraceAggregate` must persist redacted spans only, set a one-second alarm after every unique ingress ID, flush all spans for its trace at alarm time, and send metrics before applying sampling. A span arriving after a completed trace tombstone is acknowledged, dropped, and counted as `otel_backend_queue_dropped_total{backend="trace",signal="span",reason="late_span"}` rather than reopening and double-counting the trace.

- [ ] **Step 5: Implement the metrics accumulator**

Store samples by `metricSampleId` in SQLite. Aggregate by metric name, kind, and sorted labels. On flush, create an OTLP/JSON payload whose `startTimeUnixNano` is the window start and `timeUnixNano` is the flush timestamp. Use DELTA monotonic sums for `ai_gateway_requests_total` and `ai_gateway_errors_total`, DELTA histogram for `ai_gateway_request_duration_seconds`, and the existing duration buckets.

Append low-cardinality operational samples with the existing names: `otel_backend_export_retries_total`, `otel_backend_export_failures_total`, `otel_backend_export_exhausted_total`, `otel_backend_queue_dropped_total`, `otel_backend_queue_utilization_ratio`, `otel_backend_queue_oldest_age_seconds`, and `otel_ingress_rate_limited_total`.

- [ ] **Step 6: Run Durable Object verification**

Run:

```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/rate-limit.test.ts tests/otel/trace-aggregate.test.ts tests/otel/metrics-aggregate.test.ts
cd workers && npm run typecheck:otel
```

Expected: state survives eviction, duplicate Queue deliveries do not double-export, sampled-out traces still produce RED metrics, and metric windows remain DELTA.

- [ ] **Step 7: Create a commit only if the user explicitly requests one**

Stage only Task 3 files and use a message such as `feat(otel): Durable Objectで集約と重複排除を追加`.

## Task 4: Implement Redacted R2 Handoff and Authenticated Ingress

**Files:**

- Create: `workers/src/otel/storage.ts`
- Create: `workers/src/otel/queue.ts`
- Create: `workers/src/otel.ts`
- Create: `workers/tests/otel/ingress.test.ts`
- Create: `workers/tests/otel/storage.test.ts`

**Interfaces:**

- `putJsonObject<T>(bucket: R2Bucket, key: string, value: T): Promise<ObjectPointer>` stores UTF-8 JSON with SHA-256 metadata.
- `readJsonObject<T>(bucket: R2Bucket, pointer: ObjectPointer): Promise<T>` verifies the SHA-256 before parsing.
- `handleIngress(request: Request, env: OtelEnv): Promise<Response>` owns all HTTP status decisions.
- `handleQueue(batch: MessageBatch<QueuePointer>, env: OtelEnv, ctx: ExecutionContext): Promise<void>` dispatches by `batch.queue`.

- [ ] **Step 1: Add failing ingress and storage tests**

Use `SELF.fetch()` for HTTP paths and `env.OTEL_OBJECTS` for R2 assertions. Cover method/path/auth/content type/compression, content-length and streamed body overflow, invalid JSON, rate-limit `Retry-After`, capacity-drop `200`, R2 checksum mismatch, and an explicit assertion that neither R2 content nor Queue bodies contain `sk-`, `Bearer `, or the test payload secret.

```ts
it("persists only a redacted R2 envelope and queues a pointer", async () => {
  const response = await SELF.fetch(
    "https://worker.example/v1/traces",
    requestInit,
  );
  expect(response.status).toBe(200);
  const queued = await nextIngressMessage();
  expect(JSON.stringify(queued.body)).not.toContain("sk-live-test-secret");
  const object = await env.OTEL_OBJECTS.get(queued.body.objectKey);
  expect(await object?.text()).not.toContain("sk-live-test-secret");
  expect(await object?.text()).toContain("[REDACTED]");
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/ingress.test.ts tests/otel/storage.test.ts
```

Expected: FAIL because the OTel Worker entrypoint and R2 helpers do not exist.

- [ ] **Step 3: Implement canonical R2 pointers**

Use these wire types and keys. Do not include trace IDs or prompt-derived content in object keys:

```ts
export type ObjectPointer = Readonly<{
  schemaVersion: 1;
  id: string;
  objectKey: string;
  sha256: string;
  createdAtMs: number;
}>;

const ingressKey = (id: string, date: string) =>
  `otel/ingress/${date}/${id}.json`;
const exportKey = (backend: Backend, id: string, date: string) =>
  `otel/export/${backend}/${date}/${id}.json`;
```

Write `contentType: "application/json"` and custom metadata `schemaVersion: "1"`, `sha256`, and `kind`. On a checksum mismatch, throw a non-sensitive error so Queue handling retries without logging object content.

- [ ] **Step 4: Implement ingress status and persistence order**

Handle the request in this exact order:

1. Reject non-`POST /v1/traces` with `404` or `405` before reading a body.
2. Compare the bearer token through `timingSafeSecretEqual()` from `workers/src/crypto.ts`; return `401` on absent or unequal credentials.
3. Reject unsupported content type or non-identity compression with `415`.
4. Acquire and always release the 100-request ledger lease; read the stream with an 8 MiB cap and a 30-second cancelable deadline; return `413` or `408` when exceeded.
5. Rate-limit the canonical `CF-Connecting-IP`; return `429` and `Retry-After` when rejected.
6. Parse, normalize, and redact; return `400` on invalid OTLP JSON before durable storage.
7. Reserve ingress capacity in `OtelLedger`; on `capacity`, emit the operational sample and return `200` with `X-OTel-Drop-Reason: capacity`.
8. Write the redacted envelope to R2, send only its `ObjectPointer` to `OTEL_INGRESS_QUEUE`, mark the reservation enqueued, and return `200 {"reason":"accepted"}`.

If R2 write or Queue send fails, release the reservation, delete a just-written object when possible, and return `503`; never claim acceptance without a durable handoff.

- [ ] **Step 5: Route ingress Queue messages to trace Durable Objects**

For each ingress pointer, load and verify the redacted envelope once, group its spans by trace ID, and call the corresponding `OTEL_TRACE_AGGREGATE.getByName(traceId)` stub with `{ ingressId, receivedAtMs, spans }`. After every trace accepts the ingress ID, mark the ledger reservation complete and delete the ingress R2 object. If any call fails, do not acknowledge the Queue message; call `message.retry({ delaySeconds: 1 })`.

- [ ] **Step 6: Verify ingress behavior**

Run:

```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/ingress.test.ts tests/otel/storage.test.ts
cd workers && npm run typecheck:otel
```

Expected: every rejected input has its specified status, accepted input is redacted before durability, and capacity drops never cause AI Gateway retries.

- [ ] **Step 7: Create a commit only if the user explicitly requests one**

Stage only Task 4 files and use a message such as `feat(otel): redacted ingressをQueueへ永続化`.

## Task 5: Export Each Backend Independently with Retry, DLQ, and Idempotency

**Files:**

- Create: `workers/src/otel/exporter.ts`
- Modify: `workers/src/otel/queue.ts`
- Create: `workers/tests/otel/exporter.test.ts`
- Create: `workers/tests/otel/queue.test.ts`
- Modify: `workers/tests/otel/trace-aggregate.test.ts`
- Modify: `workers/tests/otel/metrics-aggregate.test.ts`

**Interfaces:**

- `enqueueBackendJob(backend: Backend, bytes: Uint8Array, contentType: string): Promise<void>` persists a redacted payload in R2 then sends an `ExportPointer` to exactly one backend Queue.
- `exportPointer(pointer: ExportPointer, backend: Backend, env: OtelEnv): Promise<ExportResult>` posts to the configured endpoint.
- `isRetryable(response: Response | null): boolean` is true only for network failure, `408`, `429`, and `5xx`.

- [ ] **Step 1: Add failing independent-backend tests**

Mock `fetch` and invoke queue handlers with `createMessageBatch()` and `getQueueResult()`. Assert all of the following:

```ts
expect(request.headers.get("content-type")).toBe("application/json");
expect(request.headers.get("authorization")).toBe("Basic test-token");
expect(result.ackAll).toBe(true);

// A retryable Tempo failure must not prevent successful Loki and metrics jobs.
expect(await queueResultFor("graft-ai-aig-otel-tempo-v1")).toMatchObject({
  retry: ["tempo-job"],
});
expect(await queueResultFor("graft-ai-aig-otel-loki-v1")).toMatchObject({
  ack: ["loki-job"],
});
```

Cover `408`, `429`, `500`, network error, `400`, `401`, `413`, checksum failure, duplicate success, three attempts, DLQ arrival, R2 delete after success, and no secrets/payloads in logs.

- [ ] **Step 2: Run focused Queue/exporter tests and confirm they fail**

Run:

```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/exporter.test.ts tests/otel/queue.test.ts
```

Expected: FAIL because backend consumer and HTTP client modules do not exist.

- [ ] **Step 3: Build redacted backend payloads before Queue handoff**

`TraceAggregate.alarm()` must enqueue a Tempo payload only for sampled traces and a Loki payload only for the selected request span of sampled traces. `OtelMetricsAggregate` must enqueue every metrics payload regardless of sampling. Each job gets a stable ID derived from `SHA-256(traceId + flushTimestamp + backend)`; store its fully encoded JSON in R2 and send only the pointer.

Reject a serialized payload above `MAX_GRAFANA_OTLP_BYTES`. For Tempo, remove non-selected spans in deterministic `startTimeUnixNano`, `spanId` order until it fits, set `graft_ai.tempo_truncated=true` on the selected span, and emit a `line_size_metadata`-style drop metric if the selected-span payload alone cannot fit. Never split an OTLP trace document.

- [ ] **Step 4: Implement manual per-message retry and DLQ semantics**

For a claimed job:

1. Send `POST` with its stored `contentType` and the backend-specific authorization secret.
2. On a `2xx`, record completion in `OtelLedger`, delete its R2 object, add any success health sample, and call `message.ack()`.
3. On retryable failure with `message.attempts < 3`, add `otel_backend_export_retries_total{backend}`, then call `message.retry({ delaySeconds })`. Use delay `1` after attempt one and `2` after attempt two; honor a valid numeric `Retry-After` only when it is greater.
4. On a non-retryable response or exhausted third attempt, record failure/exhaustion samples, call `message.retry()` only for unexpected local exceptions, and otherwise let the configured backend-specific Queue DLQ capture the pointer by throwing after the health sample write.

Never acknowledge an unexpected local error or R2 checksum failure. Queue redelivery remains the recovery path. A duplicate that finds a completed ledger job must acknowledge without another outbound request.

- [ ] **Step 5: Run Queue/exporter verification**

Run:

```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/exporter.test.ts tests/otel/queue.test.ts tests/otel/trace-aggregate.test.ts tests/otel/metrics-aggregate.test.ts
cd workers && npm run typecheck:otel
```

Expected: each backend retries independently, only retryable failures are retried, exhausted work reaches the matching DLQ, and duplicate Queue delivery remains idempotent.

- [ ] **Step 6: Create a commit only if the user explicitly requests one**

Stage only Task 5 files and use a message such as `feat(otel): backend別Queue配信を追加`.

## Task 6: Add End-to-End Regression Coverage and Deployment Automation

**Files:**

- Create: `workers/tests/otel/pipeline.test.ts`
- Create: `scripts/verify-otel-worker-config.mjs`
- Create: `scripts/otel-worker-smoke.mjs`
- Modify: `Makefile`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `README.md`
- Modify: `README.ja.md`
- Create: `docs/cloudflare-worker-ai-gateway-otel.md`

**Interfaces:**

- `make otel-worker-test` runs the isolated Worker Vitest project.
- `make otel-worker-validate` runs configuration validation, static Worker config tests, and `wrangler deploy --dry-run`.
- `make deploy-otel-worker` deploys only `wrangler.otel.jsonc`; it does not call the Logpush deployment target.
- `scripts/otel-worker-smoke.mjs` accepts `OTEL_WORKER_URL` and `OTEL_INGEST_TOKEN` from the environment and never prints either value.

- [ ] **Step 1: Add a failing full-pipeline test**

`workers/tests/otel/pipeline.test.ts` must submit a Cloudflare-shaped OTLP JSON trace containing a bearer-like prompt value, route the Queue messages, run the trace and metrics alarms, and mock all three Grafana responses.

Assert one RED metric family per selected request span, no Tempo/Loki export for a sampled-out fixture, the same trace ID in sampled Tempo/Loki output, exact Loki labels, a `[REDACTED]` payload, no credential string in R2/Queue/fetch, and an alert-compatible `otel_backend_export_exhausted_total{backend="tempo"}` sample after three Tempo failures.

- [ ] **Step 2: Run the full-pipeline test and confirm it fails**

Run:

```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/pipeline.test.ts
```

Expected: FAIL until all prior modules are wired through the Worker entrypoint.

- [ ] **Step 3: Add configuration and smoke validation**

`scripts/verify-otel-worker-config.mjs` must reject missing bindings, missing DLQs, a protobuf content type, legacy `migrations`, a non-`workers.dev` initial route, missing JSON-only validation, or inline secret values.

`scripts/otel-worker-smoke.mjs` must send a fixed OTLP/JSON fixture with a known trace ID to `${OTEL_WORKER_URL}/v1/traces`, fail for a non-`200`, and print only the status and trace ID. Do not use this script to print response bodies, endpoint authorization, prompts, or completions.

- [ ] **Step 4: Update CI and production deployment order**

Add `npm run test:otel`, `npm run typecheck:otel`, and `make otel-worker-validate` to the existing CI `checks` job.

In `deploy.yml`, add these ordered production jobs:

1. `apply-cloudflare-infrastructure`: use Terraform 1.10.0, `TF_TOKEN_app_terraform_io`, the existing production Cloudflare write token, and the current root workspace variables to apply Queue/R2 resources before Worker deployment.
2. `deploy-otel-worker`: install `workers` dependencies, synchronize the seven Worker secrets with `npx wrangler secret put <name> --config wrangler.otel.jsonc`, then run `cloudflare/wrangler-action` with `deploy --config wrangler.otel.jsonc`.
3. Keep dashboard and alert deployment parallel to the Worker deployment after `validate-deployment`; they retain the existing datasource UID substitution and query contracts.

Do not add an AI Gateway exporter update to GitHub Actions. That cutover remains an explicit human-reviewed operational action in Task 8.

- [ ] **Step 5: Write the Worker runbook**

`docs/cloudflare-worker-ai-gateway-otel.md` must document:

- the `AI Gateway -> workers.dev Worker -> Queues/R2/DO -> Grafana` topology;
- all seven secret names and the required Grafana scopes;
- `make otel-worker-test`, `make otel-worker-validate`, Terraform resource provisioning, and `make deploy-otel-worker`;
- the AI Gateway setting `URL: https://<worker>.workers.dev/v1/traces`, `Authorization: Bearer <OTEL_INGEST_TOKEN>`, and content type `json`;
- Grafana verification queries for Tempo, Loki, Prometheus, and every existing OTel alert;
- DLQ inspection/replay safety, 24-hour observation, and rollback to the still-running Tunnel route;
- the prohibition on direct Grafana exporter fallback because it bypasses the redaction boundary.

Update both READMEs to link this new runbook as the target route while stating the Tunnel/Alloy runbook remains the rollback route until Task 8 completes.

- [ ] **Step 6: Run complete pre-cutover verification**

Run:

```bash
make test
make typecheck
make fmt
make validate
make otel-worker-test
make otel-worker-validate
```

Expected: legacy Alloy and new Worker regression suites both pass during coexistence; Terraform and CI configuration validate; dashboard/alert query names remain unchanged.

- [ ] **Step 7: Create a commit only if the user explicitly requests one**

Stage only Task 6 files and use a message such as `ci(otel): Workerパイプラインを検証・配備する`.

## Task 7: Activate the Worker Route with a Controlled Rollback Window

**Files:**

- No tracked source changes.
- Uses the completed files from Tasks 1 through 6 and untracked Wrangler secrets.

**Interfaces:**

- Consumes: completed Terraform resources, deployed `workers.dev` Worker, Grafana Cloud ingest credentials, a working legacy Tunnel/Alloy route, and the AI Gateway exporter UI/API.
- Produces: one active AI Gateway JSON exporter targeting the Worker route and a 24-hour evidence record with no secrets.

- [ ] **Step 1: Do not alter remote settings until all checks pass**

Run the commands from Task 6. Stop on any failure; do not switch the AI Gateway exporter when a local check is red.

- [ ] **Step 2: Provision resources and deploy the Worker**

Run the reviewed Terraform apply and deployment workflow or its equivalent production jobs. Register only the seven named secrets through Wrangler. Confirm the deployed `workers.dev` URL without putting the bearer token in shell history, source files, or command output.

- [ ] **Step 3: Exercise the Worker before changing AI Gateway**

Set the two temporary process variables from the approved secret manager and run:

```bash
OTEL_WORKER_URL="https://<worker>.workers.dev" \
OTEL_INGEST_TOKEN="<secret-manager-value>" \
node scripts/otel-worker-smoke.mjs
```

Expected: a `200` response for the known synthetic trace. Verify its Tempo trace, redacted Loki record, canonical Prometheus series, and no alert firing. Record only non-secret status and trace ID.

- [ ] **Step 4: Atomically switch the single AI Gateway exporter**

In the Cloudflare AI Gateway configuration, edit the existing exporter rather than adding a parallel exporter:

```text
URL: https://<worker>.workers.dev/v1/traces
Header name: Authorization
Header value: Bearer <OTEL_INGEST_TOKEN>
Content type: json
```

Read back the setting. Confirm there is exactly one active exporter and it is neither a direct Grafana endpoint nor the Tunnel endpoint.

- [ ] **Step 5: Validate real traffic and observe for 24 hours**

Send one low-cost normal AI Gateway request. Within 15 minutes confirm:

```text
Tempo: { span.graft_ai.request_span = true }
Loki: {gateway="main",env="prod"} | json
Prometheus: sum by (model, provider) (increase(ai_gateway_requests_total{gateway="main",env="prod"}[15m]))
```

For 24 hours, verify all existing OTel alerts remain green, no Queue DLQ grows, `otel_backend_export_exhausted_total` remains stable, and sampled Tempo/Loki traces agree with the configured sample rate.

- [ ] **Step 6: Roll back immediately if the acceptance criteria fail**

Edit the same sole AI Gateway exporter back to the still-running legacy Tunnel endpoint with its existing bearer authentication and content type. Do not enable a direct Grafana exporter. Preserve the Worker DLQs and non-secret error observations for diagnosis.

## Task 8: Retire Tunnel and Alloy Only After the Observation Window

**Files:**

- Delete after successful Task 7: `deploy/otel/`
- Delete after successful Task 7: `scripts/verify-otel-config.mjs`
- Delete after successful Task 7: legacy Compose-specific tests under `tests/` and `deploy/otel/tests/`
- Modify after successful Task 7: `Makefile`
- Modify after successful Task 7: `README.md`
- Modify after successful Task 7: `README.ja.md`
- Modify after successful Task 7: `docs/free-tier-ai-gateway-otel.md`
- Modify after successful Task 7: `docs/cloudflare-worker-ai-gateway-otel.md`
- Modify after successful Task 7: `tests/deployment-contracts.test.mjs`
- Replace after successful Task 7: `tests/otel-contracts.test.mjs` with a Worker contract test or delete it when its coverage has moved to `workers/tests/otel/`

**Interfaces:**

- Preconditions: Task 7 completed, 24 hours of healthy Worker route evidence, no pending DLQ messages, and explicit operator confirmation that the legacy route is no longer a rollback dependency.
- Produces: a repository with one OTel implementation, one current runbook, and no active Tunnel/Alloy route.

- [ ] **Step 1: Add a failing documentation/decommission contract test**

Change `tests/deployment-contracts.test.mjs` to require the Worker topology and forbid stale OTel-route references to `cloudflared`, `docker compose`, `OTEL_INGEST_TOKEN_FILE`, and `CLOUDFLARE_OTEL_EXPORT_ENCODING=protobuf` in `docs/cloudflare-worker-ai-gateway-otel.md`, `docs/free-tier-ai-gateway-otel.md`, and the OTel sections of both READMEs. Do not forbid unrelated Codex proxy Tunnel documentation.

- [ ] **Step 2: Remove the legacy runtime and replace its checks**

Delete the tracked `deploy/otel/` source, Compose, contracts, Alloy tests, and smoke scripts. Remove `otel-node-preflight`, `otel-contracts`, `otel-alloy-test`, `otel-validate`, and `otel-smoke` targets from `Makefile`; retain the names only when they invoke the new Worker validation with no Docker or Go dependency.

Move any remaining contract fixture values required by the Worker to `workers/src/otel/contracts.ts` and `workers/tests/otel/`; do not keep a duplicate Go contract path.

- [ ] **Step 3: Retire only the OTel Tunnel infrastructure**

In Cloudflare, verify the inactive OTel Tunnel `3e3ea4a8-3d58-4ddd-8b01-3005c0f6bdf1` has no public hostname or active route, then delete that Tunnel. Do not modify the healthy `ThinkCentreTiny` Tunnel `0a467784-7185-4da5-a193-f7a9cc5a196e`, because it may serve unrelated traffic.

Stop and remove the legacy Alloy/cloudflared deployment on its host only after the OTel Tunnel deletion is confirmed. Remove its local untracked secret files through the approved host secret-management process; do not print them.

- [ ] **Step 4: Rewrite documentation to a single current route**

Update the READMEs and `docs/free-tier-ai-gateway-otel.md` to describe only the Worker route, JSON content type, Worker secret names, Queue/DLQ operations, and Grafana verification. Remove statements that Alloy is the trust boundary or that the OTel route requires Docker, Tunnel tokens, or a Compose host.

- [ ] **Step 5: Run final repository verification**

Run:

```bash
make test
make typecheck
make fmt
make validate
make otel-worker-test
make otel-worker-validate
node --test tests/deployment-contracts.test.mjs
```

Expected: no Go, Docker Compose, Alloy, or Tunnel test is required; the Worker route is the sole tested OTel implementation; all dashboard and alert contracts remain valid.

- [ ] **Step 6: Create a commit only if the user explicitly requests one**

Stage the decommissioned files and documentation only after the evidence record is accepted. Use a message such as `refactor(otel): TunnelとAlloy経路を廃止`.

## Final Verification Checklist

- [ ] AI Gateway sends exactly one OTLP/JSON exporter to `POST /v1/traces` on the Worker.
- [ ] The ingress returns `401`, `400`, `415`, `413`, `408`, `429`, and accepted `200` according to the documented conditions; capacity drop returns `200` with a drop reason.
- [ ] No raw credential, prompt, completion, or metadata reaches R2, Queues, Durable Objects, Workers logs, Grafana, DLQs, or documentation.
- [ ] Queue messages contain only SHA-verified redacted R2 pointers; successful jobs delete their R2 object and completed job tombstones absorb duplicate delivery.
- [ ] Trace grouping waits one idle second, applies the existing request-span tie-break, sends metrics before sampling, and applies one deterministic sampling decision to both Tempo and Loki.
- [ ] Loki has exactly `model`, `status_code`, `env`, and `gateway` labels; `trace_id` remains a JSON log field.
- [ ] Grafana receives JSON OTLP traces and DELTA metrics below the 4 MB export cap, plus Loki JSON records below 262,144 bytes.
- [ ] Retryable backend failures retry at most three attempts; terminal failures enter backend-specific DLQs and emit the existing alert-compatible health metrics.
- [ ] Terraform owns Queue/DLQ/R2 resources, Wrangler owns consumers/DO exports, and CI applies resources before deploying the OTel Worker.
- [ ] The legacy Tunnel/Alloy route is retained through a 24-hour healthy observation window and removed only after explicit confirmation.

## Plan Self-Review

- **Spec coverage:** Tasks 1 through 6 cover the Worker resource model, JSON-only protocol, source protection, redaction, exact selection/sampling, signal fan-out, Grafana formatting, retries, observability, Terraform, CI, docs, and tests. Task 7 covers production activation and rollback. Task 8 makes retirement conditional on verified operation.
- **Placeholder scan:** All interfaces, resource names, secrets, Queue names, limits, test commands, and cutover assertions are specified. Values represented as secret-manager inputs are intentionally not deployable literals.
- **Type consistency:** `OtelEnv`, `ObjectPointer`, `ExportPointer`, `TraceAggregate`, `OtelMetricsAggregate`, `OTEL_OBJECTS`, the four Queue bindings, and the three backend identifiers use one spelling throughout this plan.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-23-cloudflare-worker-otel-pipeline.md`.

1. **Subagent-Driven (recommended):** Dispatch a fresh subagent per task, with review between tasks.
2. **Inline Execution:** Execute tasks in this session using `superpowers:executing-plans` with checkpoints.
