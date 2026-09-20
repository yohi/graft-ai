<!-- markdownlint-disable MD013 -->

# Provider Usage Metrics Extension Implementation Plan

> **Implementation scope:** This plan describes the future source and test changes. During plan preparation only this plan and its paired design document are modified.

**Goal:** Refactor the Provider Metrics Worker to a common `ProviderResult` / `ProviderAdapter` architecture, migrate OpenCode Go and Ollama Cloud to API-key primary endpoints, add CommandCode, preserve all existing metric contracts, and add provider scrape health metrics.

**Implementation order:** Tasks are dependency ordered. Each task has one concrete interface, one RED test boundary, one minimum GREEN implementation, and one commit boundary. Global typecheck is intentionally run only after all consumers are migrated in Task 12.

**Runtime constraints:** TypeScript strict mode, Vitest, Cloudflare Workers runtime, existing dependencies only, no JSON Schema library, no credential or response-body disclosure.

## Binding Contracts

### 1. Provider result types

`ProviderResult` is a closed union discriminated by `provider`. The following fields are mandatory for the corresponding provider and are never folded into a generic field with a different metric meaning.

```ts
export interface OpenAICostMetric {
  lineItem: string;
  costUSD: number;
}

export interface ProviderModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
}

export interface ProviderModelRequest {
  period: "session" | "weekly";
  model: string;
  requestCount: number;
}

export interface ProviderResultBase<P extends ProviderId> {
  provider: P;
  sources: ProviderSource[];
  windows: QuotaWindow[];
}

export type ProviderResult =
  | (ProviderResultBase<"openai_api"> & {
      costs: OpenAICostMetric[];
      modelUsage: ProviderModelUsage[];
    })
  | (ProviderResultBase<"codex"> & {
      plan?: string;
      credits?: ProviderCredits;
    })
  | (ProviderResultBase<"opencodego"> & {
      zenBalanceUSD?: number;
    })
  | (ProviderResultBase<"ollama_cloud"> & {
      plan?: string;
      modelRequests: ProviderModelRequest[];
      activityCostUSD?: number;
    })
  | (ProviderResultBase<"commandcode"> & {
      plan?: string;
      subscription?: ProviderSubscription;
      credits?: ProviderCredits;
      usage?: ProviderUsageSummary;
    });
```

The common quota fields remain `windows`, `plan`, `subscription`, `credits`, and `usage` only where their semantics match the provider contract. OpenCode Go Zen balance uses `zenBalanceUSD`. Ollama activity cost uses `activityCostUSD`. OpenAI uses `costs` and `modelUsage`.

### 2. Error and transport seam

`ProviderErrorKind` contains the following closed set:

```text
auth | forbidden | upstream_4xx | rate_limit | upstream_5xx |
network | timeout | schema | parse | internal
```

```ts
export interface ProviderError {
  kind: ProviderErrorKind;
  provider: ProviderId;
  sourceId: string;
  statusCode?: number;
}
```

`getWithRetry()` retains `network` and `timeout` in a typed `HttpTransportError` after retries are exhausted. It does not expose raw exception messages, response bodies, credentials, or headers. HTTP responses remain available to adapters so each endpoint can attach its fixed `sourceId`.

The adapter owns the final conversion:

| Condition                          | `ProviderError.kind` |
| ---------------------------------- | -------------------- |
| HTTP 401                           | `auth`               |
| HTTP 403                           | `forbidden`          |
| HTTP 429                           | `rate_limit`         |
| HTTP 500 or greater                | `upstream_5xx`       |
| Other non-2xx response             | `upstream_4xx`       |
| Typed transport network failure    | `network`            |
| Typed transport timeout failure    | `timeout`            |
| Required JSON shape/type failure   | `schema`             |
| Required timestamp parsing failure  | `parse`              |

Fixed source ownership is endpoint-specific:

| Provider path             | `sourceId`                          |
| ------------------------- | ----------------------------------- |
| OpenAI organization APIs  | `openai-organization-api`           |
| Codex primary             | `codex-wham-usage`                  |
| Codex Browser Rendering   | `codex-browser-rendering`           |
| OpenCode Go API           | `opencodego-usage-api`              |
| OpenCode Go Zen RPC       | `opencodego-zen-rpc`                |
| Ollama API                | `ollama-api-usage`                  |
| Ollama settings HTML      | `ollama-settings-html`              |
| CommandCode whoami        | `commandcode-whoami`                |
| CommandCode credits       | `commandcode-billing-credits`       |
| CommandCode subscriptions | `commandcode-billing-subscriptions` |
| CommandCode summary       | `commandcode-usage-summary`         |

The adapter execution wrapper has a last-resort contract-violation boundary for an unexpected adapter rejection. It returns:

```ts
{
  status: "failed",
  error: {
    kind: "internal",
    provider: registryEntry.provider,
    sourceId: registryEntry.primarySourceId,
  },
}
```

The wrapper does not set `statusCode` and does not expose the rejected value, raw exception message, response body, credential, or header. `internal` is used only for an adapter rejection that violates the `AdapterOutcome` contract. Known transport, HTTP, schema, and parse failures must be returned by the provider adapter with the source ID above and must never be reclassified as `internal`.

### 3. Health timing seam

`ProviderContext` contains both clocks:

```ts
export interface ProviderContext {
  fetchFn: typeof fetch;
  scheduledTimeSeconds: number;
  /** Normalized by the orchestrator; consumed only by the OpenAI adapter. */
  openaiHistoryDays: number;
  nowSeconds: () => number;
  monotonicNowMs: () => number;
  browserBinding?: Fetcher;
}
```

The orchestrator validates `OPENAI_API_HISTORY_DAYS` before creating the context. It passes the normalized integer in `openaiHistoryDays` to the OpenAI adapter and uses `1` as the context value when OpenAI is preflight-skipped. The skipped OpenAI registry entry is not invoked in that case. The wrapper captures `monotonicNowMs()` immediately before invoking an adapter and immediately after that adapter promise settles. It captures `nowSeconds()` at the same completion point only for success and empty outcomes. `Promise.allSettled()` receives already wrapped promises, so a slow provider cannot inflate another provider's duration or timestamp.

The diagnostic report preserves `skipped`, `success`, `empty`, and `failed`. Health maps success and empty to `scrape_success=1`; the report does not relabel empty as skipped.

The adapter registry and execution record types are fixed as follows:

```ts
export type ProviderCredentialKey =
  | "OPENAI_ADMIN_API_KEY"
  | "CODEX_ACCESS_TOKEN"
  | "OPENCODEGO_API_KEY"
  | "OLLAMA_API_KEY"
  | "COMMAND_CODE_API_KEY";

export interface RegisteredProvider {
  provider: ProviderId;
  credentialKey: ProviderCredentialKey;
  primarySourceId: string;
  adapter: ProviderAdapter;
}

export type ProviderExecutionRecord =
  | {
      provider: ProviderId;
      status: "skipped";
    }
  | {
      provider: ProviderId;
      status: "attempted";
      outcome: AdapterOutcome;
      health: ScrapeHealthOutcome;
    };

export function runAdapters(
  env: ProviderMetricsEnv,
  ctx: ProviderContext,
  registry: readonly RegisteredProvider[],
): Promise<ProviderExecutionRecord[]>;
```

`runAdapters()` returns one record per registry entry in registry order. It skips entries whose `credentialKey` is absent or blank, invokes every other adapter through the completion-time wrapper, and continues after an unexpected rejection. Task 12 supplies a copy of `env` with only `OPENAI_ADMIN_API_KEY` omitted when OpenAI preflight configuration is invalid; this preserves the same exact `skipped` record and no-health/no-push semantics without adding a provider-specific branch to `runAdapters()`.

### 4. Metric builder and push input

The metric builder signature is fixed:

```ts
buildProviderMetrics(
  results: ProviderResult[],
  nowUnixNano: string,
  nowSeconds: number,
): Record<string, unknown>[]
```

`opencodego_reset_seconds_remaining{period}` is generated as:

```text
max(resetTimestampSeconds - nowSeconds, 0)
```

The push function receives data and health metrics in one required payload object:

```ts
export interface ProviderMetricsPushInput {
  results: ProviderResult[];
  healthMetrics: Record<string, unknown>[];
  nowUnixNano: string;
  nowSeconds: number;
}
```

An attempted run always passes the health array to the push function, including an empty data-result array. The orchestrator does not call the push function only when no provider was attempted.

## File Structure

### Modified files

- `workers/src/http-retry.ts` — preserve typed network/timeout failures after retry exhaustion.
- `workers/src/provider-metrics/types.ts` — define the closed result union, transport/error types, context seam, and credentials.
- `workers/src/provider-metrics/prometheus.ts` — emit exact common and provider-specific metrics and accept health metrics in the push payload.
- `workers/src/provider-metrics.ts` — run the registry, build data/health payloads, and produce complete diagnostics.
- `workers/src/provider-metrics/codex.ts` — return `AdapterOutcome` and classify primary/browser failures.
- `workers/src/provider-metrics/openai-api.ts` — return the OpenAI union member with cost line items and model usage.
- `workers/tests/provider-metrics/scheduled.test.ts` — verify orchestration and observable push payloads.
- `workers/tests/provider-metrics/prometheus.test.ts` — verify exact metric names, labels, and values.
- `docs/provider-metrics.md` — document credentials, source support levels, and new metrics.

### Created files

- `workers/src/provider-metrics/health.ts`
- `workers/src/provider-metrics/adapters.ts`
- `workers/src/provider-metrics/opencodego/index.ts`
- `workers/src/provider-metrics/opencodego/api-key.ts`
- `workers/src/provider-metrics/opencodego/zen-balance.ts`
- `workers/src/provider-metrics/ollama/index.ts`
- `workers/src/provider-metrics/ollama/api-usage.ts`
- `workers/src/provider-metrics/ollama/settings-html.ts`
- `workers/src/provider-metrics/commandcode/index.ts`
- `workers/src/provider-metrics/commandcode/billing.ts`
- `workers/tests/provider-metrics/types-smoke.test-d.ts`
- `workers/tests/http-retry.test.ts`
- `workers/tests/provider-metrics/health.test.ts`
- `workers/tests/provider-metrics/adapters.test.ts`
- `workers/tests/provider-metrics/ollama-api-usage.test.ts`
- `workers/tests/provider-metrics/ollama-settings-html.test.ts`
- `workers/tests/provider-metrics/commandcode.test.ts`

### Removed files

- `workers/src/provider-metrics/opencodego.ts` — remove after Cookie/RPC Zen-balance helpers are moved to `opencodego/zen-balance.ts` and all imports use `opencodego/index.ts`.
- `workers/src/provider-metrics/ollama.ts` — remove after its parser is moved to the new Ollama module.

### Preserved files

- `workers/src/provider-metrics/opencodego-parser.ts` — retain as the legacy HTML/RPC parser helper owned by `opencodego/zen-balance.ts`; do not perform an unrelated parser refactor.

### Renamed test files

- `workers/tests/provider-metrics/opencodego-validation.test.ts` → `workers/tests/provider-metrics/opencodego-api-key.test.ts`
- `workers/tests/provider-metrics/opencodego.test.ts` → `workers/tests/provider-metrics/opencodego-zen-balance.test.ts`

## Task 1: Define types and typed transport errors

**Files:**

- Modify: `workers/src/provider-metrics/types.ts`
- Modify: `workers/src/http-retry.ts`
- Create: `workers/tests/provider-metrics/types-smoke.test-d.ts`
- Create: `workers/tests/http-retry.test.ts`

**Consumes:** Existing provider result interfaces and `getWithRetry()`.

**Dependency:** None. This task establishes the shared types and transport seam.

**Produces:** `ProviderResult` closed union, `ProviderModelUsage`, `ProviderModelRequest`, `OpenAICostMetric`, `ProviderContext.openaiHistoryDays`, `ProviderContext.monotonicNowMs`, `ProviderErrorKind` including `internal`, `ProviderError`, `HttpTransportError`, and new credential keys.

### RED

Add a type smoke test with all five union members. The test must assign these exact values:

```ts
const openai: ProviderResult = {
  provider: "openai_api",
  sources: [],
  windows: [],
  costs: [{ lineItem: "tokens", costUSD: 1.25 }],
  modelUsage: [
    {
      model: "gpt-5",
      inputTokens: 10,
      outputTokens: 4,
      cachedTokens: 2,
      requests: 1,
    },
  ],
};

const codex: ProviderResult = {
  provider: "codex",
  sources: [],
  windows: [],
  plan: "pro",
  credits: {
    remaining: 10,
  },
};

const opencodego: ProviderResult = {
  provider: "opencodego",
  sources: [],
  windows: [],
  zenBalanceUSD: 23.45,
};

const ollama: ProviderResult = {
  provider: "ollama_cloud",
  sources: [],
  windows: [],
  modelRequests: [
    { period: "session", model: "glm-5.3-flash", requestCount: 54 },
  ],
  activityCostUSD: 12.34,
};

const commandcode: ProviderResult = {
  provider: "commandcode",
  sources: [],
  windows: [],
  plan: "pro",
  credits: {
    remaining: 20,
  },
};
```

Add transport tests that make `fetchFn` reject with a timeout-shaped error and a network-shaped error after retry exhaustion. The expected errors are `HttpTransportError` with `kind` equal to `timeout` and `network`, respectively.

`types-smoke.test-d.ts` is a type-only Vitest test. It must be checked with Vitest's typecheck mode; the repository's regular `vitest run` path does not typecheck and is not evidence for the closed-union contract. `--typecheck.ignoreSourceErrors` is required here because Tasks 2-11 intentionally leave existing consumers to be migrated; it ignores unrelated source-file errors while still checking the selected type-test file.

**RED command:** From `workers/`, run:

```bash
npx vitest --typecheck.only --typecheck.ignoreSourceErrors tests/provider-metrics/types-smoke.test-d.ts
npx vitest run tests/http-retry.test.ts
```

**Expected RED result:**

- `types-smoke.test-d.ts`: Typecheck fails because the closed `ProviderResult` union and provider-specific exports or fields are missing or still have the legacy shape.
- `tests/http-retry.test.ts`: Runtime tests fail because `HttpTransportError` or the typed network/timeout behavior is not implemented.

### GREEN

Implement the exact union and error types from the Binding Contracts. Include `internal` in the closed `ProviderErrorKind` set, but do not emit it from `getWithRetry()` or any normal adapter failure path. Update `getWithRetry()` so timeout detection produces `HttpTransportError("timeout")`, other exhausted fetch exceptions produce `HttpTransportError("network")`, and the existing retry/status behavior is unchanged. Do not include the caught exception message in the public error or log output.

Add `OPENCODEGO_API_KEY`, `OPENCODEGO_SESSION_COOKIE`, `OPENCODEGO_WORKSPACE_ID`, `OLLAMA_API_KEY`, `OLLAMA_SESSION_COOKIE`, and `COMMAND_CODE_API_KEY` to `ProviderMetricsEnv`.

**GREEN command:**

```bash
npx vitest --typecheck.only --typecheck.ignoreSourceErrors tests/provider-metrics/types-smoke.test-d.ts
npx vitest run tests/http-retry.test.ts
```

**Expected GREEN result:** The type-only contract check passes under Vitest typecheck mode, and the separate runtime transport tests pass while proving the network/timeout distinction.

### Commit

```bash
git add workers/src/provider-metrics/types.ts workers/src/http-retry.ts workers/tests/provider-metrics/types-smoke.test-d.ts workers/tests/http-retry.test.ts
git commit -m "feat(provider-metrics): 共通型とtyped transport errorを定義"
```

## Task 2: Implement scrape health builder

**Files:**

- Create: `workers/src/provider-metrics/health.ts`
- Create: `workers/tests/provider-metrics/health.test.ts`

**Consumes:** `ProviderId` and the health timing contract from Task 1.

**Dependency:** Task 1.

**Produces:** `ScrapeHealthOutcome` and `buildHealthMetrics()`.

### RED

Add tests for success, empty, and failed outcomes. Assert that success and empty emit `provider_metrics_scrape_success=1`, failure emits `0`, duration is emitted for all attempted outcomes, and timestamp is emitted only for success and empty.

**RED command:**

```bash
npx vitest run tests/provider-metrics/health.test.ts
```

**Expected RED result:** The health module and builder export do not exist.

### GREEN

Define:

```ts
export interface ScrapeHealthOutcome {
  provider: ProviderId;
  status: "success" | "empty" | "failed";
  durationSeconds: number;
  timestampSeconds?: number;
}
```

Generate one gauge metric object per provider and metric name. Never emit a timestamp for failed outcomes or skipped providers.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/health.test.ts
```

**Expected GREEN result:** Health metric tests pass with the exact success/timestamp/duration semantics.

### Commit

```bash
git add workers/src/provider-metrics/health.ts workers/tests/provider-metrics/health.test.ts
git commit -m "feat(provider-metrics): scrape health metric builderを追加"
```

## Task 3: Implement the exact metric builder and push payload shape

**Files:**

- Modify: `workers/src/provider-metrics/prometheus.ts`
- Modify: `workers/tests/provider-metrics/prometheus.test.ts`

**Consumes:** The closed `ProviderResult` union from Task 1.

**Dependency:** Task 1.

**Produces:** `buildProviderMetrics(results, nowUnixNano, nowSeconds)` and `pushProviderMetrics(env, input, fetchFn)`.

### RED

Replace the existing builder test with a fixture containing OpenAI, OpenCode Go, and Ollama results. Assert these exact contracts:

```text
openai_api_cost_usd{line_item="tokens"}
openai_api_input_tokens{model="gpt-5"}
openai_api_output_tokens{model="gpt-5"}
openai_api_cached_tokens{model="gpt-5"}
openai_api_requests{model="gpt-5"}
opencodego_zen_balance_usd
opencodego_reset_seconds_remaining{period="weekly"}
ollama_cloud_model_requests{period="session",model="glm-5.3-flash"}
ollama_cloud_activity_cost_usd
```

For quota metrics, collect all metric objects with the requested name before asserting. The test must not assume that multiple data points are stored in one metric object. Assert the OpenCode Go remaining value using `resetTimestampSeconds=1_250` and `nowSeconds=1_000`, expecting `250`.

Add a push test that supplies one data result and one health metric and asserts both appear under the POSTed OTLP payload. The test must also supply an empty data-result array with a non-empty health array and assert that the health metric remains in the payload.

**RED command:**

```bash
npx vitest run tests/provider-metrics/prometheus.test.ts
```

**Expected RED result:** The current builder accepts the legacy result shape, lacks the new exact metrics, and cannot accept the health payload.

### GREEN

Implement an exhaustive `switch (result.provider)`:

- OpenAI emits cost metrics from `costs` and four model metrics from `modelUsage`.
- Codex emits the existing quota, credits, and plan metrics.
- OpenCode Go emits quota metrics, `opencodego_reset_seconds_remaining`, and `opencodego_zen_balance_usd` from `zenBalanceUSD`.
- Ollama emits quota, plan, model request, and activity cost metrics from the dedicated fields.
- CommandCode emits its existing quota, credits, subscription, and usage metrics.

Use `assertNever` for the closed union. Do not construct provider-specific names from a generic `usage` object. Make `buildOtlpPayload()` accept both data metrics and health metrics. Make `pushProviderMetrics()` accept the required `ProviderMetricsPushInput` object and include both arrays in one payload.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/prometheus.test.ts
```

**Expected GREEN result:** Exact names, labels, values, reset remaining calculation, and health-only payload tests pass.

### Commit

```bash
git add workers/src/provider-metrics/prometheus.ts workers/tests/provider-metrics/prometheus.test.ts
git commit -m "feat(provider-metrics): exact metric builderとhealth payloadを追加"
```

## Task 4: Implement adapter registry and completion-time wrapper

**Files:**

- Create: `workers/src/provider-metrics/adapters.ts`
- Create: `workers/tests/provider-metrics/adapters.test.ts`

**Consumes:** `ProviderContext`, `ProviderAdapter`, `AdapterOutcome`, and `ScrapeHealthOutcome` from Tasks 1 and 2.

**Dependency:** Tasks 1 and 2.

**Produces:** The exact `RegisteredProvider`, `ProviderExecutionRecord`, and `runAdapters(env, ctx, registry)` interfaces from Binding Contracts. `runAdapters()` returns one ordered record per registry entry, including `skipped` records.

### RED

Add tests for credential skipping, parallel execution, success/empty/failed health mapping, and completion-time measurement. The timing test uses two deferred adapters. The fast adapter settles while the slow adapter remains pending, and the injected monotonic clock returns `0` at both starts, `100` at the fast completion, and `10_000` at the slow completion. Assert durations of `0.1` and `10` seconds and distinct completion timestamps. Add a test where one adapter rejects unexpectedly: its record is `status = "attempted"`, `outcome.status = "failed"`, `outcome.error.kind = "internal"`, `outcome.error.sourceId` equals that registry entry's fixed `primarySourceId`, `statusCode` is absent, and the other adapter still completes.

**RED command:**

```bash
npx vitest run tests/provider-metrics/adapters.test.ts
```

**Expected RED result:** The registry module is absent; the legacy orchestrator has no completion-time wrapper.

### GREEN

Define the exact `RegisteredProvider` and `ProviderExecutionRecord` types from Binding Contracts. Filter registry entries by non-empty credential. For each selected entry, execute this wrapper:

```text
startMs = ctx.monotonicNowMs()
try:
  outcome = await adapter(env, ctx)
catch unexpected rejection:
  outcome = {
    status: "failed",
    error: {
      kind: "internal",
      provider: registryEntry.provider,
      sourceId: registryEntry.primarySourceId,
    },
  }
endMs = ctx.monotonicNowMs()
timestamp = ctx.nowSeconds() when outcome is success or empty
return outcome and health computed from these immediate completion values
```

Create a `skipped` record for every registry entry whose credential is absent or blank. For every invoked entry, create an `attempted` record with the adapter outcome and `ScrapeHealthOutcome`. Pass the wrapped promises to `Promise.allSettled()`. Preserve the registry order in returned outcomes and health records. Known provider failures must be classified inside their adapters; the wrapper's `internal` contract-violation path is not the normal transport/error path, and it must not expose the rejected value.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/adapters.test.ts
```

**Expected GREEN result:** Fast-provider duration/timestamp values are independent of slow-provider settlement, skipped providers never invoke their adapter, unexpected rejection is isolated as `internal` with the registry primary source, and other providers continue.

### Commit

```bash
git add workers/src/provider-metrics/adapters.ts workers/tests/provider-metrics/adapters.test.ts
git commit -m "feat(provider-metrics): adapter completion wrapperを追加"
```

## Task 5: Implement OpenCode Go API-key adapter

**Files:**

- Create: `workers/src/provider-metrics/opencodego/api-key.ts`
- Create: `workers/src/provider-metrics/opencodego/index.ts`
- Rename/update: `workers/tests/provider-metrics/opencodego-validation.test.ts` to `workers/tests/provider-metrics/opencodego-api-key.test.ts`

**Consumes:** OpenCode Go API key, `ProviderContext` from Task 1, and the status/exceeded contract in Design §6.1.

**Dependency:** Task 1.

**Produces:** `AdapterOutcome` for `opencodego` using `/zen/go/v1/usage`, including the Design §6.1 status-to-`QuotaWindow.exceeded` semantics.

### RED

Add fixtures for the valid rolling/weekly/monthly response, missing required window, invalid percent, invalid optional `resetsAt`, invalid JSON, 401, 403 `EntitlementError`, other 403, 429, 500, network, and timeout. The normal fixture uses `status: "ok"` and must assert `QuotaWindow.exceeded === false` for that window. Add table-driven status cases for the Design §6.1 semantic rule and assert:

- success contains three `QuotaWindow` entries and source `opencodego-usage-api`;
- normal/available status (`status: "ok"`) keeps the valid percentage and maps to `exceeded = false`;
- `status: "rate-limited"` with `percent = 100` returns `success` and maps to `exceeded = true`;
- `status: "exhausted"` with `percent = 100` returns `success` and maps to `exceeded = true`;
- `status: "rate-limited"` or `status: "exhausted"` with any `percent != 100` returns `failed`, `error.kind = "schema"`, `error.sourceId = "opencodego-usage-api"`, and no data result;
- invalid optional `resetsAt` keeps `success`, omits only that window's `resetTimestampSeconds`, and returns no `ProviderError`;
- `403 + EntitlementError` is empty;
- all other failures retain `opencodego-usage-api`;
- network and timeout retain distinct `ProviderError.kind` values.

**RED command:**

```bash
npx vitest run tests/provider-metrics/opencodego-api-key.test.ts
```

**Expected RED result:** The API-key adapter module is absent.

### GREEN

Use `getWithRetry()` with the specified timeout and headers. Convert status and typed transport errors using the fixed source ID. Parse the required three windows into `QuotaWindow[]`. Validate `status` as a non-empty string and `percent` as a finite `0..100` number. Preserve the Design §6.1 status semantics: normal/available status such as `ok` maps to `exceeded = false`; `rate-limited` and `exhausted` require exactly `percent = 100` and map to `exceeded = true`; either status with `percent != 100` returns `failed` with `kind = "schema"` and `sourceId = "opencodego-usage-api"`. Return `schema` for required `usage` / window / `status` / `percent` shape or range failures. Map invalid JSON to `parse`. `resetsAt` is optional: missing or invalid `resetsAt` omits only that window's `resetTimestampSeconds`, returns quota `success`, and does not create a `ProviderError`. Treat only safe `EntitlementError` 403 as empty.

The adapter entry reads `OPENCODEGO_API_KEY` only. Missing credentials are handled by the registry and never produce an adapter call.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/opencodego-api-key.test.ts
```

**Expected GREEN result:** All endpoint, status, transport, schema, parse, and empty semantics pass.

### Commit

```bash
git mv workers/tests/provider-metrics/opencodego-validation.test.ts workers/tests/provider-metrics/opencodego-api-key.test.ts
git add workers/src/provider-metrics/opencodego workers/tests/provider-metrics/opencodego-api-key.test.ts
git commit -m "feat(provider-metrics): OpenCode Go API key adapterを追加"
```

## Task 6: Implement OpenCode Go Zen balance enrichment

**Files:**

- Create: `workers/src/provider-metrics/opencodego/zen-balance.ts`
- Modify: `workers/src/provider-metrics/opencodego/index.ts`
- Modify: `workers/src/provider-metrics.ts` — update the legacy OpenCode Go import/call site to the new `opencodego/index.ts` entry; Task 12 consumes this entry from the registry.
- Rename/update: `workers/tests/provider-metrics/opencodego.test.ts` to `workers/tests/provider-metrics/opencodego-zen-balance.test.ts`
- Remove: `workers/src/provider-metrics/opencodego.ts`
- Preserve: `workers/src/provider-metrics/opencodego-parser.ts` as the legacy HTML/RPC parser helper owned by `zen-balance.ts`.

**Consumes:** The successful OpenCode Go result from Task 5 and existing cookie/RPC helpers.

**Dependency:** Task 5.

**Produces:** Optional `zenBalanceUSD` enrichment with `opencodego-zen-rpc` provenance, a single `opencodego/index.ts` entry point, migrated imports, and no legacy `workers/src/provider-metrics/opencodego.ts` implementation.

### RED

Add tests for configured cookie with a balance, missing cookie, and RPC failure. Assert that a successful enrichment sets `result.zenBalanceUSD`, adds source role `enrichment`, and does not set `result.credits`. Assert that enrichment failure preserves quota success and emits no Zen balance. The migrated test must import the new `../../src/provider-metrics/opencodego/index` entry, and no test or source import may reference the deleted `opencodego.ts` file.

**RED command:**

```bash
npx vitest run tests/provider-metrics/opencodego-zen-balance.test.ts
```

**Expected RED result:** The new enrichment module and provider-specific field are absent.

### GREEN

Move the required existing cookie/RPC extraction into `workers/src/provider-metrics/opencodego/zen-balance.ts` and expose it through `fetchZenBalanceEnrichment()`. The helper may continue to use the preserved `opencodego-parser.ts`; do not refactor unrelated parser code. After API success, call it only when the session cookie is configured. Store the numeric value in `zenBalanceUSD`; never store it in `credits.remaining`. Append `opencodego-zen-rpc` only when the value contributed to the result. Update `workers/src/provider-metrics.ts` and every migrated test import to `opencodego/index.ts`, then delete the legacy `workers/src/provider-metrics/opencodego.ts`.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/opencodego-zen-balance.test.ts tests/provider-metrics/opencodego-api-key.test.ts
```

**Expected GREEN result:** Quota success is independent of optional Zen balance failure, and the source role is enrichment.

### Commit

```bash
git mv workers/tests/provider-metrics/opencodego.test.ts workers/tests/provider-metrics/opencodego-zen-balance.test.ts
git rm workers/src/provider-metrics/opencodego.ts
git add workers/src/provider-metrics/opencodego workers/tests/provider-metrics/opencodego-zen-balance.test.ts
git add workers/src/provider-metrics.ts
git commit -m "feat(provider-metrics): OpenCode Go Zen balance enrichmentを追加"
```

## Task 7: Implement Ollama Cloud API-key adapter

**Files:**

- Create: `workers/src/provider-metrics/ollama/api-usage.ts`
- Create: `workers/tests/provider-metrics/ollama-api-usage.test.ts`

**Consumes:** `OLLAMA_API_KEY`, `ProviderContext` from Task 1, and the model-label validation/cardinality contract in Design §6.2, §7.2, and §8.6.

**Dependency:** Task 1.

**Produces:** An `AdapterOutcome` that distinguishes API success from request failure and fatal 200-response schema/parse failure, with validated and `(period, model)`-aggregated `modelRequests`.

### RED

Add fixtures for:

- legacy session/weekly limits with duplicate model entries;
- activity cost with `last_4_weeks` period;
- activity-only success;
- invalid model entry with valid limits;
- model names covering valid characters, exactly 128 ASCII characters, 129 characters, leading/trailing/internal whitespace, whitespace-only input, control characters, and non-string values;
- invalid activity cost with valid limits;
- empty or unrecognized top-level content;
- invalid JSON;
- 400, 401, 403, 429, 500, network, and timeout.

Assert that success stores `modelRequests` with session/weekly periods, stores cost in `activityCostUSD`, ignores `activity.models[]`, and never creates a monthly quota window. For `limits.*.models[].name`, assert the Design §6.2 rule exactly: accept only a string whose `trimmed = name.trim()` has ASCII length `1..128`, whose original value equals `trimmed`, and whose full value matches `^[A-Za-z0-9._:/-]+$`; do not coerce, normalize, case-fold, or replace the label. Assert that a valid 128-character name is retained, a 129-character name is omitted, leading/trailing/internal whitespace and control-character names are omitted, and a non-string name is omitted. Assert duplicate entries with the same `(period, model)` key are emitted as one `modelRequests` entry with the summed `requestCount` (for example, `3 + 4 = 7`), while the same model in `session` and `weekly` remains two independent entries with separate counts. Assert that HTTP 400 returns `failed` with `ProviderError.kind = "upstream_4xx"`, `ProviderError.sourceId = "ollama-api-usage"`, and `statusCode = 400`. Assert that empty primary content is a fatal `schema` failure, invalid JSON is `parse`, and API 200 failures never return `null` for fallback interpretation.

**RED command:**

```bash
npx vitest run tests/provider-metrics/ollama-api-usage.test.ts
```

**Expected RED result:** The API-key adapter module is absent.

### GREEN

Return a typed `AdapterOutcome` from the API module. Parse `limits.session` and `limits.weekly` into quota windows and `modelRequests`. Before aggregation, validate each model entry with the Design §6.2 policy: `name` must be a string, `trimmed = name.trim()` must have ASCII length `1..128`, `name` must equal `trimmed`, and the original name must fully match `^[A-Za-z0-9._:/-]+$`. Omit only invalid entries without coercion, normalization, case folding, or `unknown`/`other` replacement. Aggregate only validated entries by the exact `(period, model)` key, so duplicate entries in one period sum `requestCount` and the same model in `session` and `weekly` remains separate. Parse activity cost into `activityCostUSD`. Keep invalid optional model entries and activity cost as field-level omissions. If neither limits nor activity cost contributes a valid primary field, return failed `schema`. Map JSON decoding failure to `parse`.

Map HTTP and typed transport failures to `ProviderError` with source `ollama-api-usage`. Do not call HTML from this module. HTML fallback ownership belongs exclusively to Task 8.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/ollama-api-usage.test.ts
```

**Expected GREEN result:** API success, optional omissions, fatal 200 failures, and all error categories pass.

### Commit

```bash
git add workers/src/provider-metrics/ollama workers/tests/provider-metrics/ollama-api-usage.test.ts
git commit -m "feat(provider-metrics): Ollama Cloud API usage adapterを追加"
```

## Task 8: Implement Ollama HTML enrichment/fallback and adapter entry

**Files:**

- Create: `workers/src/provider-metrics/ollama/settings-html.ts`
- Create: `workers/src/provider-metrics/ollama/index.ts`
- Remove: `workers/src/provider-metrics/ollama.ts`
- Rename/update: `workers/tests/provider-metrics/ollama.test.ts` to `workers/tests/provider-metrics/ollama-settings-html.test.ts`

**Consumes:** Typed API outcomes from Task 7 and the existing settings HTML parser.

**Dependency:** Task 7.

**Produces:** A state machine with separate API-success enrichment and request-failure fallback paths.

### RED

Add tests for all ownership boundaries:

- API 200 success plus HTML plan/reset contribution keeps API quota/activity as primary and adds only plan/reset fields as enrichment.
- API 200 success plus HTML quota usage does not add HTML quota values to the primary result.
- API 200 fatal schema failure does not call HTML and remains failed with `schema` or `parse`.
- API HTTP 500 plus valid HTML quota/plan/reset returns fallback success with only `ollama-settings-html` as a source.
- API HTTP 400 plus valid HTML quota/plan/reset returns fallback success with `ollama-settings-html` as the `fallback` source.
- API HTTP 400 plus HTML failure preserves `ProviderError.kind = "upstream_4xx"`, `statusCode = 400`, and `sourceId = "ollama-api-usage"`.
- API network or timeout plus unavailable HTML preserves the original `network` or `timeout` and `ollama-api-usage`.
- API failure plus HTML failure preserves the original API kind, status code, and source.
- API success with no valid HTML contribution remains success without the HTML source.
- HTML reset-only contribution is sufficient for fallback success.

**RED command:**

```bash
npx vitest run tests/provider-metrics/ollama-settings-html.test.ts tests/provider-metrics/ollama-api-usage.test.ts
```

**Expected RED result:** The split module and the ownership-specific tests are absent.

### GREEN

Make `fetchOllamaSettingsHtml()` return a typed HTML contribution containing independently validated plan, quota windows, and reset timestamps. Its request failure is represented separately from an empty contribution.

Implement the adapter state machine in this order:

1. Call the API adapter.
2. On API success, call HTML only when the cookie exists, and merge plan plus missing reset timestamps. Do not merge HTML usage ratios or add HTML quota windows to the API result.
3. On API `network`, `timeout`, `auth`, `forbidden`, `upstream_4xx`, `rate_limit`, or `upstream_5xx` failure, call HTML only when the cookie exists. Replace the complete result only when HTML contributes at least one valid quota window, plan, or reset timestamp.
4. On API `schema` or `parse` failure after HTTP 200, do not call HTML.
5. On fallback failure, return the original API `ProviderError` unchanged.
6. Assign `ollama-settings-html` the runtime role `enrichment` only for API success contribution and `fallback` only for complete fallback success.

Move the existing parser helpers without placeholder code and remove the old adapter module after imports are updated.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/ollama-settings-html.test.ts tests/provider-metrics/ollama-api-usage.test.ts
```

**Expected GREEN result:** Fatal 200 responses never become HTML success, HTML quota never contaminates API success, and fallback preserves original failure ownership.

### Commit

```bash
git rm workers/src/provider-metrics/ollama.ts workers/tests/provider-metrics/ollama.test.ts
git add workers/src/provider-metrics/ollama workers/tests/provider-metrics/ollama-settings-html.test.ts workers/tests/provider-metrics/ollama-api-usage.test.ts
git commit -m "feat(provider-metrics): Ollama HTML ownershipを実装"
```

## Task 9: Implement CommandCode adapter

**Files:**

- Create: `workers/src/provider-metrics/commandcode/billing.ts`
- Create: `workers/src/provider-metrics/commandcode/index.ts`
- Create: `workers/tests/provider-metrics/commandcode.test.ts`

**Consumes:** `COMMAND_CODE_API_KEY`, typed transport errors, and the fixed four-endpoint graph.

**Dependency:** Task 1.

**Produces:** CommandCode `AdapterOutcome` with endpoint-specific source ownership and partial enrichment semantics.

### RED

Add request tests asserting exact URLs, `limits=1`, encoded `orgId`, optional encoded `since`, required headers, and no request body. Add response tests for valid output, invalid whoami, invalid credits, optional subscription failure, optional summary failure, invalid resetAt, unlimited semantics, bounded quota `cap=0`, network, timeout, 401, 403, 429, 500, invalid JSON, and required schema/parse errors.

Every required endpoint failure must assert its own source:

```text
whoami                 -> commandcode-whoami
billing/credits       -> commandcode-billing-credits
billing/subscriptions -> commandcode-billing-subscriptions
usage/summary         -> commandcode-usage-summary
```

Assert that `whoami` is never included in `ProviderResult.sources`; valid subscription and summary fields add their source only when they contribute a field.

**RED command:**

```bash
npx vitest run tests/provider-metrics/commandcode.test.ts
```

**Expected RED result:** The CommandCode modules are absent.

### GREEN

Implement a typed endpoint helper that receives the fixed source ID and converts HTTP/transport/JSON errors before returning endpoint data. Keep `whoami` as an internal prerequisite. Treat credits/quota as required primary data. Treat subscription and summary as optional enrichment, preserving credits success when they fail.

Implement the exact quota rules from the design: `fiveHour` maps to `session`, `weekly` maps to `weekly`, `limited=false` emits no window, and `limited=true` requires both positive-cap entries. Invalid optional `resetAt` omits only the reset timestamp.

The adapter catch path must use the typed endpoint failure's `kind`, `sourceId`, and `statusCode`; it must not infer endpoint ownership from an error message or assign every failure to credits.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/commandcode.test.ts
```

**Expected GREEN result:** Request graph, partial success, exact source ownership, quota normalization, and all error categories pass.

### Commit

```bash
git add workers/src/provider-metrics/commandcode workers/tests/provider-metrics/commandcode.test.ts
git commit -m "feat(provider-metrics): CommandCode adapterを追加"
```

## Task 10: Refactor Codex adapter to ProviderResult

**Files:**

- Modify: `workers/src/provider-metrics/codex.ts`
- Modify: `workers/tests/provider-metrics/codex.test.ts`
- Modify: `workers/tests/provider-metrics/codex-validation.test.ts`

**Consumes:** `ProviderContext`, typed transport errors, and Browser Rendering binding.

**Dependency:** Task 1.

**Produces:** Codex `AdapterOutcome` with exact primary/browser ownership.

### RED

Update existing tests to unwrap `AdapterOutcome`. Add cases for primary 403 with browser success, browser launch/navigation/response timeout, browser schema/parse failure, browser binding unavailable, primary 401, 429, 5xx, network, timeout, primary 200 schema/parse failure, and reset-credit enrichment failure.

Assert:

- Browser fallback is attempted only for primary HTTP 403 with an available binding.
- Browser success uses source `codex-browser-rendering` with role `fallback`.
- Browser failure uses source `codex-browser-rendering` and the browser-side final category.
- Binding unavailable retains `forbidden`, source `codex-wham-usage`, status `403`.
- Primary 429 and 5xx remain `rate_limit` and `upstream_5xx` and do not invoke Browser Rendering.

**RED command:**

```bash
npx vitest run tests/provider-metrics/codex.test.ts tests/provider-metrics/codex-validation.test.ts
```

**Expected RED result:** Existing tests expect the legacy result shape and the current implementation does not satisfy the browser error contract.

### GREEN

Return the Codex union member with session/weekly windows, plan, and credits. Convert primary responses with the fixed source ID. On primary 403, invoke Browser Rendering only when available; classify its final network, timeout, schema, or parse failure from the browser operation and use the browser source ID. Do not classify every browser failure as forbidden.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/codex.test.ts tests/provider-metrics/codex-validation.test.ts
```

**Expected GREEN result:** Existing Codex metrics remain compatible and all fallback ownership tests pass.

### Commit

```bash
git add workers/src/provider-metrics/codex.ts workers/tests/provider-metrics/codex.test.ts workers/tests/provider-metrics/codex-validation.test.ts
git commit -m "refactor(provider-metrics): CodexをProviderResultへ移行"
```

## Task 11: Refactor OpenAI adapter to ProviderResult

**Files:**

- Modify: `workers/src/provider-metrics/openai-api.ts`
- Modify: `workers/tests/provider-metrics/openai-api.test.ts`

**Consumes:** Existing organization costs/completions aggregation, typed transport errors, and the normalized `ProviderContext.openaiHistoryDays` / `ProviderContext.scheduledTimeSeconds` values from Task 1 and Task 12.

**Dependency:** Task 1.

**Produces:** OpenAI union member with exact line-item and model payloads.

### RED

Update adapter tests to expect `AdapterOutcome`. Add a fixture with two cost line items and two models, then assert the result retains every `lineItem` and every model's input/output/cached/request values. Add HTTP 401, 403, 429, 5xx, network, timeout, invalid JSON, and required schema/parse cases with source `openai-organization-api`. Invoke the adapter with normalized `openaiHistoryDays = 1` and `31` and a fixed `scheduledTimeSeconds`; assert the generated `start_time` and `end_time` use that context value rather than wall clock time.

Add a builder-level assertion that these values become the existing metric names and labels without collapsing cost line items into `usage.costUSD`.

**RED command:**

```bash
npx vitest run tests/provider-metrics/openai-api.test.ts tests/provider-metrics/prometheus.test.ts
```

**Expected RED result:** The adapter still returns `OpenAIFetchResult`, while the new builder requires the OpenAI union member.

### GREEN

Keep the existing page, pagination, and aggregation logic. Construct:

```text
ProviderResult.provider = "openai_api"
ProviderResult.costs = aggregated OpenAIMetric[]
ProviderResult.modelUsage = aggregated OpenAITokenMetric[]
ProviderResult.windows = []
```

Do not populate generic `usage.costUSD` for OpenAI. Read the validated `ctx.openaiHistoryDays` and use `ctx.scheduledTimeSeconds` as the UTC day anchor for both API requests; the adapter must not parse `OPENAI_API_HISTORY_DAYS` or read wall clock time. Map all typed transport, HTTP, schema, and parse errors to the fixed source ID. Preserve zero-valued token fields as metrics because the existing contract emits them.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/openai-api.test.ts tests/provider-metrics/prometheus.test.ts
```

**Expected GREEN result:** Existing OpenAI metric names/labels and line-item/model values remain unchanged.

### Commit

```bash
git add workers/src/provider-metrics/openai-api.ts workers/tests/provider-metrics/openai-api.test.ts
git commit -m "refactor(provider-metrics): OpenAIをProviderResultへ移行"
```

## Task 12: Refactor orchestrator and verify health-only push

**Files:**

- Modify: `workers/src/provider-metrics.ts`
- Modify: `workers/tests/provider-metrics/scheduled.test.ts`

**Consumes:** `RegisteredProvider[]`, `ProviderExecutionRecord[]`, and `runAdapters()` from Task 4; all adapters from Tasks 5–11; metric builders from Tasks 2–3.

**Dependency:** Tasks 2–11.

**Produces:** Complete diagnostic report and one data-plus-health OTLP push path.

### RED

Rewrite scheduled tests with wire-level assertions on the POST body. Add these scenarios:

1. One success, one empty, one failure, and one skipped provider. Assert report status for every provider and health status/timestamp semantics.
2. All configured providers fail. Assert one POST occurs and its metrics include `provider_metrics_scrape_success` and `provider_metrics_scrape_duration_seconds` for every attempted provider.
3. All providers are skipped. Assert no POST occurs.
4. Successful data plus health metrics. Assert both are present in the same OTLP payload.
5. Ollama API failure plus HTML fallback success. Assert only fallback provenance.
6. `OPENAI_API_HISTORY_DAYS` is unset. Assert the OpenAI adapter receives `openaiHistoryDays = 1`.
7. Configured values `"1"` and `"31"` are accepted; `"0"`, `"32"`, a non-integer, and a non-numeric value preflight-skip OpenAI without invoking its adapter.
8. Invalid OpenAI history configuration with another attempted provider continues that provider, emits no OpenAI health outcome, and pushes the attempted provider's data/health. With no other attempted provider, assert no POST.
9. A fixed scheduled event time is converted once to `scheduledTimeSeconds`, and the OpenAI request window uses that value as its UTC anchor.

**RED command:**

```bash
npx vitest run tests/provider-metrics/scheduled.test.ts
```

**Expected RED result:** The legacy orchestrator has no registry, no health payload, no health-only push, and no complete status mapping.

### GREEN

Task 12 owns OpenAI configuration preflight. Parse `OPENAI_API_HISTORY_DAYS` exactly once as `raw === undefined ? 1 : Number(raw)`, accepting only `Number.isInteger(value)` in `1..31`. Build `ProviderContext` with the normalized `openaiHistoryDays`, `scheduledTimeSeconds = Math.floor(scheduledTimeMs / 1000)`, and the `nowSeconds` / `monotonicNowMs` seams. If the configured value is invalid, use context value `1` but pass a copy of `env` with only `OPENAI_ADMIN_API_KEY` omitted to `runAdapters()`; this creates the OpenAI `skipped` record without invoking the adapter. This preflight result is not a `ProviderError`, does not create OpenAI health, and does not block other providers.

Define the registry with exactly these entries, one fixed credential key, fixed `primarySourceId`, and adapter per provider:

```text
openai_api   -> OPENAI_ADMIN_API_KEY   -> openai-organization-api
codex        -> CODEX_ACCESS_TOKEN     -> codex-wham-usage
opencodego   -> OPENCODEGO_API_KEY     -> opencodego-usage-api
ollama_cloud -> OLLAMA_API_KEY         -> ollama-api-usage
commandcode  -> COMMAND_CODE_API_KEY   -> commandcode-billing-credits
```

Use the new `./provider-metrics/opencodego/index` entry and never import the deleted legacy `opencodego.ts`. Call `runAdapters()` once and consume its `ProviderExecutionRecord[]` directly.

Build the report by iterating the registry and joining each provider with its `ProviderExecutionRecord`. Map adapter statuses exactly:

```text
skipped -> skipped
success -> success
empty   -> empty
failed  -> failed with kind:sourceId diagnostic, including `internal` for wrapper contract violations
```

Set `attempted = true` when at least one execution record has `status = "attempted"`; skipped records, including invalid OpenAI preflight, do not set it. When `attempted` is false, return without POST. When `attempted` is true, build data metrics from successful `record.outcome` results, build health metrics from all `record.health` values, and call:

```ts
pushProviderMetrics(env, {
  results: successfulResults,
  healthMetrics,
  nowUnixNano,
  nowSeconds,
});
```

The push function must receive health metrics even when `successfulResults` is empty. Do not create and discard an intermediate metrics array. Use the same timestamps for the entire payload.

**GREEN command:**

```bash
npx vitest run tests/provider-metrics/scheduled.test.ts
npm run typecheck
```

**Expected GREEN result:** Scheduled integration tests prove direct execution-record joining, health-only push, all-skipped no-push, Ollama fallback provenance, OpenAI history default/range/invalid semantics, and scheduled-time window anchoring. The first global typecheck passes with no known consumer compile failure.

### Commit

```bash
git add workers/src/provider-metrics.ts workers/tests/provider-metrics/scheduled.test.ts
git commit -m "refactor(provider-metrics): orchestratorをhealth push対応へ移行"
```

## Task 13: Update operator documentation and run final gates

**Files:**

- Modify: `docs/provider-metrics.md`

**Consumes:** The final contracts implemented by Tasks 1–12.

**Dependency:** Tasks 1–12.

**Produces:** Operator documentation for credentials, source support, exact metrics, health semantics, and fallback ownership.

### RED

From the repository root, run the documentation contract check below before editing `docs/provider-metrics.md`:

```bash
required='OPENCODEGO_API_KEY OLLAMA_API_KEY COMMAND_CODE_API_KEY opencodego_zen_balance_usd opencodego_reset_seconds_remaining ollama_cloud_model_requests ollama_cloud_activity_cost_usd provider_metrics_scrape_success'
for word in $required; do grep -F "$word" docs/provider-metrics.md >/dev/null || exit 1; done
```

**Expected RED result:** At least one new credential, metric, or health contract is absent from the operator document.

### GREEN

Add sections for:

- primary credentials and fallback/enrichment credentials;
- source IDs and support levels;
- exact OpenAI, OpenCode Go, Ollama, CommandCode, and health metric names;
- empty versus failed health semantics;
- health-only push and all-skipped no-push behavior;
- Ollama API success enrichment versus API request-failure fallback;
- Codex Browser Rendering ownership.

Run the same contract check after the edit.

**GREEN command:** From `workers/`, run:

```bash
npm run typecheck
npm test
npm run fmt:check
```

From the repository root, run:

```bash
make validate
```

**Expected GREEN result:** The documentation contract check, Worker typecheck, Worker test suite, formatter check, and repository validation all pass.

### Commit

```bash
git add docs/provider-metrics.md
git commit -m "docs(provider-metrics): 新しいcredentialとmetric契約を記載"
```

## Traceability

| Contract                                | Design location        | Implementing task        | Required test evidence                                                |
| --------------------------------------- | ---------------------- | ------------------------ | --------------------------------------------------------------------- |
| OpenAI existing metric compatibility    | `§6.4`, `§7.2`, `§9.3` | Tasks 3, 11, 12          | line-item and model-label assertions                                  |
| OpenCode Go Zen balance                 | `§6.1`, `§7.2`         | Task 6                   | `zenBalanceUSD` source/metric assertion                               |
| OpenCode Go reset-seconds compatibility | `§7.2`, `§9.3`         | Task 3                   | injected `nowSeconds` formula assertion                               |
| OpenCode Go status / exceeded semantics | `§6.1`, `§10.1`         | Task 5                   | normal/available status, rate-limited/exhausted at 100, and non-100 schema-failure assertions |
| Ollama model requests                   | `§6.2`, `§7.2`, `§9.3` | Tasks 3, 7               | session/weekly period and model-label assertions                      |
| Ollama model-label validation/cardinality | `§6.2`, `§7.2`, `§8.6`, `§10.1` | Task 7 | exact string/ASCII/length/whitespace/control validation and invalid-entry omission assertions |
| Ollama duplicate model-request aggregation | `§6.2`, `§7.2`, `§10.1` | Task 7 | exact `(period, model)` aggregation, summed `requestCount`, and separate session/weekly series assertions |
| Ollama activity cost                    | `§6.2`, `§7.2`         | Tasks 3, 7               | exact `ollama_cloud_activity_cost_usd` assertion                      |
| Ollama fallback/enrichment precedence   | `§6.2`, `§8.1`         | Tasks 7, 8               | API 200 fatal, HTTP 400 fallback success/failure, API success enrichment, request-failure fallback tests |
| CommandCode endpoint error ownership    | `§6.3`, `§8.7`         | Task 9                   | endpoint table-driven source assertions                               |
| Codex browser fallback ownership        | `§6.5`, `§8.7`         | Task 10                  | browser success/failure/binding-unavailable tests                     |
| Timeout/network distinction             | `§4.3`, `§8.2`, `§8.3` | Tasks 1, 5, 7, 9, 10, 11 | typed transport and adapter category assertions                       |
| Unexpected adapter rejection isolation  | `§4.3`, `§8.1`         | Tasks 1, 4, 12           | `internal` kind, fixed primary source, no status code, other provider continues |
| OpenAI history-window configuration compatibility | `§6.4`, `§9.1`–`§9.3` | Tasks 1, 11, 12 | default/range/invalid preflight, normalized value, scheduled-time anchor, diagnostic/health/push assertions |
| OpenCode Go legacy implementation migration | `§5`, `§6.1`, `§9.2` | Task 6 | helper ownership, import migration, legacy `opencodego.ts` deletion |
| Scrape duration completion semantics    | `§4.4`, `§7.5`         | Tasks 2, 4, 12           | fast/slow deferred adapter test                                       |
| Scrape timestamp completion semantics   | `§4.4`, `§7.5`         | Tasks 2, 4, 12           | immediate completion timestamp assertion                              |
| Health-only push                        | `§4.4`, `§7.6`, `§8.1` | Tasks 3, 12              | all-failed payload contains health metrics                            |
| All-skipped no-push                     | `§4.4`, `§8.1`, `§9.1` | Task 12                  | credential/config skipped and POST count remains zero                  |

## Final Self-Review

### Type and interface checklist

- `ProviderResult` is a provider-discriminated union.
- OpenAI line items and model usage are retained until the builder.
- OpenCode Go Zen balance cannot become a generic credits metric.
- Ollama model requests include `period` and `model`; activity cost has its exact field.
- `ProviderContext` has `scheduledTimeSeconds`, normalized `openaiHistoryDays`, and both injectable clocks.
- `ProviderErrorKind` includes network, timeout, HTTP 4xx/5xx, schema, parse, and contract-only `internal`.
- OpenCode Go status semantics map normal/available windows to `exceeded = false`, `rate-limited`/`exhausted` at 100 to `exceeded = true`, and non-100 `rate-limited`/`exhausted` to schema failure.
- Ollama model labels use the Design §6.2 exact validation policy, omit invalid entries, and aggregate only by exact `(period, model)`.
- `RegisteredProvider`, `ProviderExecutionRecord`, and `runAdapters()` have exact fields, arguments, return type, and ordered-record semantics.
- Fixed source IDs are endpoint-specific and not inferred from error strings.
- `pushProviderMetrics` requires data and health input together.
- Diagnostic status preserves skipped, success, empty, and failed.

### Plan consistency checklist

- Every task has Files, Consumes, Produces, Dependency context, RED test, RED command, expected RED result, minimum GREEN implementation, GREEN command, expected GREEN result, and commit boundary.
- No task claims global typecheck success while a known consumer remains broken.
- No task contains an unresolved implementation choice.
- No task contains a placeholder implementation block.
- The metric test asserts the shape produced by the builder.
- The traceability table covers all listed metric, error, ownership, timing, and push contracts.
- Only the source files listed in the task being executed may be changed during implementation.

### Final verification commands

```bash
git diff --check
git status --short
```

From `workers/`:

```bash
npm run typecheck
npm test
npm run fmt:check
```

From the repository root:

```bash
make validate
```

The implementation is not ready for handoff until all commands pass and the working tree contains only the intended task changes.
