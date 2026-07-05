<!-- markdownlint-disable MD013 -->

# Ollama Cloud Rate Limit Reset Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a new Cloudflare Worker that derives Ollama Cloud session /
weekly rate-limit reset metrics from a configured anchor time, and pushes them
to Grafana Cloud Metrics for visualization.

**Architecture:** Add a standalone scheduled Worker (`ollama-cloud.ts`) with two
helpers: a reset-time calculator (`calc.ts`) and an OTLP/JSON metrics client
(`prometheus.ts`). Use Cloudflare Cron Triggers for periodic execution, and
Grafana Cloud OTLP endpoint for metric ingestion.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest, Wrangler, Grafana Cloud
OTLP/HTTP JSON endpoint.

## Global Constraints

- TypeScript with strict settings (`workers/tsconfig.json`).
- Package manager: npm (inside `workers/`).
- Secrets: never commit or store in `*.tfvars`; use `workers/.dev.vars` for
  local development and Wrangler secrets for deployed Workers.
- CI expectations: `make test`, `make typecheck`, `make fmt`, and `make validate`
  must pass before merging.
- All new code must have unit or integration tests.
- Follow existing patterns in `workers/src/` and `workers/tests/`.
- Prefer small, focused files with single responsibility.

---

## Notes on Protocol Choice

The approved design spec says "Grafana Cloud Prometheus への remote write".
After technical research, this plan uses **OTLP/HTTP JSON to the Grafana Cloud
OTLP endpoint** instead of raw Prometheus remote_write (protobuf + snappy). The
reasons are:

1. Cloudflare Workers has no built-in Snappy or protobuf support, making raw
   remote_write heavy and dependency-prone.
2. Grafana Cloud OTLP endpoint accepts OTLP/JSON and stores metrics in the same
   managed Prometheus backend.
3. The payload is plain JSON, testable without binary serialization.

If the reviewer prefers raw remote_write, revisit this decision before Task 3.

---

### Task 1: Add `OllamaCloudEnv` type

**Files:**

- Modify: `workers/src/types.ts`

**Interfaces:**

- Consumes: existing `BaseEnv` pattern.
- Produces: `OllamaCloudEnv` interface used by all Ollama Cloud modules.

- [ ] **Step 1: Add the new env type**

Append to `workers/src/types.ts`:

```typescript
export interface OllamaCloudEnv {
  OLLAMA_CLOUD_PLAN?: string;
  OLLAMA_CLOUD_SESSION_INTERVAL_SECONDS?: string;
  OLLAMA_CLOUD_WEEKLY_INTERVAL_SECONDS?: string;
  OLLAMA_CLOUD_RESET_ANCHOR_ISO: string;
  GRAFANA_CLOUD_PROMETHEUS_URL: string;
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: string;
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: string;
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd workers && npm run typecheck:ci
```

Expected: passes with no errors.

- [ ] **Step 3: Commit**

```bash
cd workers && npm run fmt
cd ..
git add workers/src/types.ts
git commit -m "feat(ollama): OllamaCloudEnv 型を追加"
```

---

### Task 2: Implement reset-time calculator

**Files:**

- Create: `workers/src/ollama-cloud/calc.ts`
- Test: `workers/tests/ollama-cloud/calc.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `ResetCalculation` interface
  - `computeReset(nowSeconds, anchorSeconds, intervalSeconds, period)` function

- [ ] **Step 1: Write the failing test**

Create `workers/tests/ollama-cloud/calc.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeReset } from "../../src/ollama-cloud/calc";

describe("computeReset", () => {
  it("computes session reset from anchor", () => {
    const result = computeReset(3600, 0, 18000, "session");
    expect(result.period).toBe("session");
    expect(result.intervalSeconds).toBe(18000);
    expect(result.remainingSeconds).toBe(14400);
    expect(result.nextResetTimestampSeconds).toBe(18000);
    expect(result.progressRatio).toBeCloseTo(0.2);
  });

  it("computes weekly reset from anchor", () => {
    const result = computeReset(86400, 0, 604800, "weekly");
    expect(result.period).toBe("weekly");
    expect(result.intervalSeconds).toBe(604800);
    expect(result.remainingSeconds).toBe(518400);
    expect(result.nextResetTimestampSeconds).toBe(604800);
    expect(result.progressRatio).toBeCloseTo(0.142857, 5);
  });

  it("wraps around after multiple intervals", () => {
    const result = computeReset(19000, 0, 18000, "session");
    expect(result.remainingSeconds).toBe(17000);
    expect(result.nextResetTimestampSeconds).toBe(36000);
    expect(result.progressRatio).toBeCloseTo(0.0556, 3);
  });

  it("handles negative elapsed time gracefully", () => {
    const result = computeReset(0, 3600, 18000, "session");
    expect(result.remainingSeconds).toBe(14400);
    expect(result.nextResetTimestampSeconds).toBe(18000);
  });

  it("throws on non-positive interval", () => {
    expect(() => computeReset(0, 0, 0, "session")).toThrow();
    expect(() => computeReset(0, 0, -1, "session")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd workers && npx vitest run tests/ollama-cloud/calc.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

Create `workers/src/ollama-cloud/calc.ts`:

```typescript
export interface ResetCalculation {
  period: "session" | "weekly";
  intervalSeconds: number;
  nextResetTimestampSeconds: number;
  remainingSeconds: number;
  progressRatio: number;
}

export function computeReset(
  nowSeconds: number,
  anchorSeconds: number,
  intervalSeconds: number,
  period: "session" | "weekly",
): ResetCalculation {
  if (intervalSeconds <= 0) {
    throw new Error(`intervalSeconds must be positive, got ${intervalSeconds}`);
  }
  const elapsed = nowSeconds - anchorSeconds;
  const remainder =
    ((elapsed % intervalSeconds) + intervalSeconds) % intervalSeconds;
  const progressRatio = remainder / intervalSeconds;
  const remainingSeconds = intervalSeconds - remainder;
  const nextResetTimestampSeconds = nowSeconds + remainingSeconds;
  return {
    period,
    intervalSeconds,
    nextResetTimestampSeconds,
    remainingSeconds,
    progressRatio,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd workers && npx vitest run tests/ollama-cloud/calc.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd workers && npm run fmt
cd ..
git add workers/src/ollama-cloud/calc.ts workers/tests/ollama-cloud/calc.test.ts
git commit -m "feat(ollama): リセット時間計算を実装"
```

---

### Task 3: Implement OTLP/JSON metrics client

**Files:**

- Create: `workers/src/ollama-cloud/prometheus.ts`
- Test: `workers/tests/ollama-cloud/prometheus.test.ts`

**Interfaces:**

- Consumes: `ResetCalculation` from Task 2, `OllamaCloudEnv` from Task 1.
- Produces:
  - `pushMetrics(env, calculations, plan, fetchFn)` function returning
    `{ ok: boolean; status: number }`

- [ ] **Step 1: Write the failing test**

Create `workers/tests/ollama-cloud/prometheus.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { pushMetrics } from "../../src/ollama-cloud/prometheus";
import type { ResetCalculation } from "../../src/ollama-cloud/calc";

const env = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://otlp-gateway-prod-us-central1.grafana.net/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "test-token",
};

const calc: ResetCalculation = {
  period: "session",
  intervalSeconds: 18000,
  nextResetTimestampSeconds: 18000,
  remainingSeconds: 14400,
  progressRatio: 0.2,
};

describe("pushMetrics", () => {
  it("returns ok on HTTP 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const result = await pushMetrics(env, [calc], "pro", mockFetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends JSON Content-Type and Basic Auth", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushMetrics(env, [calc], "pro", mockFetch);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe(`Basic ${btoa("123456:test-token")}`);
  });

  it("posts to the OTLP metrics endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushMetrics(env, [calc], "pro", mockFetch);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe("https://otlp-gateway-prod-us-central1.grafana.net/otlp/v1/metrics");
  });

  it("retries on HTTP 429 up to 2 times", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Too Many Requests", { status: 429 }));
    const result = await pushMetrics(env, [calc], "pro", mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry on HTTP 400", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Bad Request", { status: 400 }));
    const result = await pushMetrics(env, [calc], "pro", mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on network failure up to 2 times", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await pushMetrics(env, [calc], "pro", mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("includes all three metric names in the payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushMetrics(env, [calc], "pro", mockFetch);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
    const names = metrics.map((m: { name: string }) => m.name);
    expect(names).toContain("ollama_cloud_reset_seconds_remaining");
    expect(names).toContain("ollama_cloud_reset_timestamp_seconds");
    expect(names).toContain("ollama_cloud_reset_progress_ratio");
    expect(names).toContain("ollama_cloud_plan_info");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd workers && npx vitest run tests/ollama-cloud/prometheus.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

Create `workers/src/ollama-cloud/prometheus.ts`:

```typescript
import type { OllamaCloudEnv } from "../types";
import type { ResetCalculation } from "./calc";

type PrometheusEnv = Pick<
  OllamaCloudEnv,
  | "GRAFANA_CLOUD_PROMETHEUS_URL"
  | "GRAFANA_CLOUD_PROMETHEUS_USERNAME"
  | "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"
>;

const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 500;
const PER_ATTEMPT_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOtlpPayload(
  calculations: ResetCalculation[],
  plan: string,
  nowUnixNano: string,
): Record<string, unknown> {
  const metrics = calculations.flatMap((calc) => {
    const baseAttrs = [{ key: "period", value: { stringValue: calc.period } }];
    return [
      {
        name: "ollama_cloud_reset_seconds_remaining",
        gauge: {
          dataPoints: [
            {
              attributes: baseAttrs,
              asDouble: calc.remainingSeconds,
              timeUnixNano: nowUnixNano,
            },
          ],
        },
      },
      {
        name: "ollama_cloud_reset_timestamp_seconds",
        gauge: {
          dataPoints: [
            {
              attributes: baseAttrs,
              asDouble: calc.nextResetTimestampSeconds,
              timeUnixNano: nowUnixNano,
            },
          ],
        },
      },
      {
        name: "ollama_cloud_reset_progress_ratio",
        gauge: {
          dataPoints: [
            {
              attributes: baseAttrs,
              asDouble: calc.progressRatio,
              timeUnixNano: nowUnixNano,
            },
          ],
        },
      },
    ];
  });

  metrics.push({
    name: "ollama_cloud_plan_info",
    gauge: {
      dataPoints: [
        {
          attributes: [
            { key: "plan", value: { stringValue: plan } },
            { key: "session_interval", value: { stringValue: "18000" } },
            { key: "weekly_interval", value: { stringValue: "604800" } },
          ],
          asDouble: 1,
          timeUnixNano: nowUnixNano,
        },
      ],
    },
  });

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "graft-ai-ollama-cloud" },
            },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "graft-ai-ollama-cloud" },
            metrics,
          },
        ],
      },
    ],
  };
}

export async function pushMetrics(
  env: PrometheusEnv,
  calculations: ResetCalculation[],
  plan: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url = `${env.GRAFANA_CLOUD_PROMETHEUS_URL}/v1/metrics`;
  const basicAuth = btoa(
    `${env.GRAFANA_CLOUD_PROMETHEUS_USERNAME}:${env.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}`,
  );
  const nowUnixNano = `${Date.now()}000000`;
  const body = JSON.stringify(buildOtlpPayload(calculations, plan, nowUnixNano));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Basic ${basicAuth}`,
  };

  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      await sleep(backoffMs);
    }

    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS),
      });
      lastStatus = response.status;

      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status };
      }

      if (response.status !== 429) {
        return { ok: false, status: response.status };
      }
    } catch (err) {
      lastStatus = 0;
      console.error(
        `Ollama Cloud metrics push attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { ok: false, status: lastStatus };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd workers && npx vitest run tests/ollama-cloud/prometheus.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd workers && npm run fmt
cd ..
git add workers/src/ollama-cloud/prometheus.ts workers/tests/ollama-cloud/prometheus.test.ts
git commit -m "feat(ollama): OTLP/JSON metrics client を実装"
```

---

### Task 4: Implement scheduled Worker entry point

**Files:**

- Create: `workers/src/ollama-cloud.ts`
- Test: `workers/tests/ollama-cloud/scheduled.test.ts`

**Interfaces:**

- Consumes: `OllamaCloudEnv`, `computeReset`, `pushMetrics`.
- Produces: default exported scheduled handler.

- [ ] **Step 1: Write the failing integration test**

Create `workers/tests/ollama-cloud/scheduled.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import worker from "../../src/ollama-cloud";

describe("ollama-cloud worker", () => {
  it("exports a scheduled handler", () => {
    expect(worker.scheduled).toBeDefined();
    expect(typeof worker.scheduled).toBe("function");
  });
});
```


- [ ] **Step 2: Write the scheduled handler**

Create `workers/src/ollama-cloud.ts`:

```typescript
import type { OllamaCloudEnv } from "./types";
import { computeReset } from "./ollama-cloud/calc";
import { pushMetrics } from "./ollama-cloud/prometheus";

const DEFAULT_SESSION_INTERVAL_SECONDS = 18000;
const DEFAULT_WEEKLY_INTERVAL_SECONDS = 604800;

function parseInterval(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid interval: ${value}`);
  }
  return parsed;
}

export interface OllamaCloudWorker {
  scheduled(
    event: ScheduledEvent,
    env: OllamaCloudEnv,
    ctx: ExecutionContext,
  ): Promise<void>;
}

const worker: OllamaCloudWorker = {
  async scheduled(event, env, ctx) {
    const anchorIso = env.OLLAMA_CLOUD_RESET_ANCHOR_ISO;
    if (!anchorIso) {
      console.error("OLLAMA_CLOUD_RESET_ANCHOR_ISO is not configured");
      return;
    }

    const anchorMs = Date.parse(anchorIso);
    if (Number.isNaN(anchorMs)) {
      console.error(`Invalid OLLAMA_CLOUD_RESET_ANCHOR_ISO: ${anchorIso}`);
      return;
    }

    const anchorSeconds = Math.floor(anchorMs / 1000);
    const nowSeconds = Math.floor(event.scheduledTime / 1000);

    const sessionInterval = parseInterval(
      env.OLLAMA_CLOUD_SESSION_INTERVAL_SECONDS,
      DEFAULT_SESSION_INTERVAL_SECONDS,
    );
    const weeklyInterval = parseInterval(
      env.OLLAMA_CLOUD_WEEKLY_INTERVAL_SECONDS,
      DEFAULT_WEEKLY_INTERVAL_SECONDS,
    );

    const calculations = [
      computeReset(nowSeconds, anchorSeconds, sessionInterval, "session"),
      computeReset(nowSeconds, anchorSeconds, weeklyInterval, "weekly"),
    ];

    const plan = env.OLLAMA_CLOUD_PLAN ?? "unknown";
    const result = await pushMetrics(env, calculations, plan);
    if (!result.ok) {
      console.error(
        `Failed to push Ollama Cloud metrics: status=${result.status}`,
      );
    }
  },
};

export default worker;
```

- [ ] **Step 3: Refine the integration test**

Update `workers/tests/ollama-cloud/scheduled.test.ts` to inject a mock fetch and
verify the handler calls `pushMetrics`. Because `pushMetrics` calls the global
`fetch`, use `vi.stubGlobal("fetch", mockFetch)` before calling the handler.

```typescript
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/ollama-cloud";

const baseEnv = {
  OLLAMA_CLOUD_PLAN: "pro",
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://otlp-gateway-prod-us-central1.grafana.net/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
};

describe("ollama-cloud scheduled handler", () => {
  it("pushes metrics when anchor is configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const scheduledEvent = {
      scheduledTime: new Date("2026-01-01T00:00:00Z").getTime(),
      cron: "*/5 * * * *",
    } as ScheduledEvent;

    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await worker.scheduled(
      scheduledEvent,
      {
        ...baseEnv,
        OLLAMA_CLOUD_RESET_ANCHOR_ISO: "2026-01-01T00:00:00Z",
      } as typeof baseEnv & { OLLAMA_CLOUD_RESET_ANCHOR_ISO: string },
      ctx,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe("https://otlp-gateway-prod-us-central1.grafana.net/otlp/v1/metrics");

    vi.unstubAllGlobals();
  });

  it("logs error and skips when anchor is missing", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const scheduledEvent = {
      scheduledTime: new Date("2026-01-01T00:00:00Z").getTime(),
      cron: "*/5 * * * *",
    } as ScheduledEvent;

    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await worker.scheduled(
      scheduledEvent,
      {
        ...baseEnv,
        OLLAMA_CLOUD_RESET_ANCHOR_ISO: "",
      } as typeof baseEnv & { OLLAMA_CLOUD_RESET_ANCHOR_ISO: string },
      ctx,
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("OLLAMA_CLOUD_RESET_ANCHOR_ISO"),
    );

    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd workers && npx vitest run tests/ollama-cloud/scheduled.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd workers && npm run fmt
cd ..
git add workers/src/ollama-cloud.ts workers/tests/ollama-cloud/scheduled.test.ts
git commit -m "feat(ollama): scheduled Worker エントリポイントを実装"
```

---

### Task 5: Add Wrangler configuration

**Files:**

- Create: `workers/wrangler.ollama.jsonc`

**Interfaces:**

- Consumes: `workers/src/ollama-cloud.ts`.
- Produces: deployable Worker config.

- [ ] **Step 1: Create Wrangler config**

Create `workers/wrangler.ollama.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "graft-ai-ollama-cloud",
  "main": "src/ollama-cloud.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true
  },
  "triggers": {
    "crons": ["*/5 * * * *"]
  },
  "vars": {
    "OLLAMA_CLOUD_PLAN": "",
    "OLLAMA_CLOUD_SESSION_INTERVAL_SECONDS": "18000",
    "OLLAMA_CLOUD_WEEKLY_INTERVAL_SECONDS": "604800"
  }
}
```

- [ ] **Step 2: Verify Wrangler config syntax**

```bash
cd workers && npx wrangler deploy --config wrangler.ollama.jsonc --dry-run
```

Expected: no syntax errors.

- [ ] **Step 3: Update local dev vars example**

Append to `workers/.dev.vars.example`:

```bash
# Ollama Cloud reset metrics
OLLAMA_CLOUD_PLAN=
OLLAMA_CLOUD_SESSION_INTERVAL_SECONDS=18000
OLLAMA_CLOUD_WEEKLY_INTERVAL_SECONDS=604800
OLLAMA_CLOUD_RESET_ANCHOR_ISO=2026-01-01T00:00:00Z
GRAFANA_CLOUD_PROMETHEUS_URL=https://otlp-gateway-prod-us-central1.grafana.net/otlp
GRAFANA_CLOUD_PROMETHEUS_USERNAME=123456
GRAFANA_CLOUD_ACCESS_POLICY_TOKEN=glc_xxxxxxxxxxxx
```

- [ ] **Step 4: Commit**

```bash
git add workers/wrangler.ollama.jsonc workers/.dev.vars.example
git commit -m "feat(ollama): Wrangler 設定を追加"
```

---

### Task 6: Add Makefile target

**Files:**

- Modify: `Makefile`

**Interfaces:**

- Consumes: `workers/wrangler.ollama.jsonc`.
- Produces: `make deploy-ollama` command.

- [ ] **Step 1: Add deploy-ollama target**

Append to `Makefile`:

```makefile
deploy-ollama:
	cd workers && npx wrangler deploy --config wrangler.ollama.jsonc
```

- [ ] **Step 2: Verify Makefile syntax**

```bash
make -n deploy-ollama
```

Expected: prints the command without errors.

- [ ] **Step 3: Commit**

```bash
git add Makefile
git commit -m "feat(ollama): make deploy-ollama ターゲットを追加"
```

---

### Task 7: Create Grafana dashboard

**Files:**

- Create: `grafana/dashboards/graft-ai-ollama-cloud.json`

**Interfaces:**

- Consumes: `ollama_cloud_reset_*` metrics.
- Produces: dashboard JSON importable via gcx.

- [ ] **Step 1: Create dashboard JSON**

Create `grafana/dashboards/graft-ai-ollama-cloud.json` with these panels:

1. **Session reset remaining** — Stat panel for
   `ollama_cloud_reset_seconds_remaining{period="session"}`.
2. **Weekly reset remaining** — Stat panel for
   `ollama_cloud_reset_seconds_remaining{period="weekly"}`.
3. **Session progress** — Gauge panel for
   `ollama_cloud_reset_progress_ratio{period="session"}`.
4. **Weekly progress** — Gauge panel for
   `ollama_cloud_reset_progress_ratio{period="weekly"}`.
5. **Reset timeline** — Time series for
   `ollama_cloud_reset_timestamp_seconds`.
6. **Alerts**:
   - `ollama_cloud_reset_seconds_remaining{period="session"} < 3600`
   - `ollama_cloud_reset_seconds_remaining{period="weekly"} < 86400`

Use the same dashboard schema version and datasource convention as
`grafana/dashboards/graft-ai-overview.json`.

- [ ] **Step 2: Validate JSON syntax**

```bash
python3 -m json.tool grafana/dashboards/graft-ai-ollama-cloud.json > /dev/null
```

Expected: no output (valid JSON).

- [ ] **Step 3: Commit**

```bash
git add grafana/dashboards/graft-ai-ollama-cloud.json
git commit -m "feat(ollama): Ollama Cloud ダッシュボードを追加"
```

---

### Task 8: Full validation and documentation

**Files:**

- Modify: `docs/superpowers/specs/2026-07-05-ollama-cloud-reset-design.md` (optional)
- Modify: `README.md` (optional)

- [ ] **Step 1: Run all checks**

```bash
make typecheck
make test
make fmt
```

Expected: all pass.

- [ ] **Step 2: Update design spec if needed**

If the OTLP/JSON protocol choice should be reflected in the design spec, edit
`docs/superpowers/specs/2026-07-05-ollama-cloud-reset-design.md` section 5.1 to
say "Grafana Cloud Metrics (Prometheus backend) via OTLP/HTTP JSON".

- [ ] **Step 3: Update README (optional)**

Add a short Ollama Cloud subsection under the Subsystems section of
`README.md` linking to the new dashboard and Worker.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(ollama): 実装に伴うドキュメント更新"
```

---

## Self-Review

### Spec coverage

| Spec Section | Implementing Task |
| --- | --- |
| New scheduled Worker | Task 4 |
| Reset calculator | Task 2 |
| Prometheus/OTLP client | Task 3 |
| Configuration values | Tasks 1, 5 |
| Error handling | Tasks 2, 3, 4 |
| Testing | All tasks |
| Deployment | Tasks 5, 6 |
| Dashboard | Task 7 |

### Placeholder scan

- No "TBD", "TODO", or "implement later".
- Each step includes concrete code or commands.
- File paths are exact.

### Type consistency

- `OllamaCloudEnv` used consistently across Tasks 1, 3, 4.
- `ResetCalculation` produced by Task 2 and consumed by Task 3.
- `pushMetrics` signature matches between Task 3 tests and implementation.

---

## Execution Handoff

Plan complete and saved to
`docs/superpowers/plans/2026-07-05-ollama-cloud-reset.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task,
review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using
`superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
