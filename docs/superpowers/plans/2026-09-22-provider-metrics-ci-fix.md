# Provider Metrics CI Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the provider-metrics foundation branch's type-safe and runtime-correct handoff to the new Prometheus push contract.

**Architecture:** Keep the legacy provider fetch orchestration intact on this foundation branch. Add one conversion boundary in `provider-metrics.ts` that maps its legacy fetch results into the existing closed `ProviderResult` union, then call `pushProviderMetrics` with the required `results`, `healthMetrics`, and injected time fields. The later registry-driven orchestration remains a separate stacked change.

**Tech Stack:** TypeScript, Vitest, Wrangler, npm.

## Global Constraints

- Preserve existing provider metric names and scheduled-handler behavior.
- Do not weaken the closed `ProviderResult` type or add an `any`/unchecked cast.
- Keep provider-specific time calculations outside the metric builder.
- Do not alter unrelated worktree contents, commits, or branches.

---

### Task 1: Bridge legacy fetch results to the push contract

**Files:**
- Modify: `workers/src/provider-metrics.ts:1-176`
- Test: `workers/tests/provider-metrics/scheduled.test.ts`

**Interfaces:**
- Consumes: legacy `OpenAIFetchResult`, `CodexFetchResult`, `OpenCodeGoFetchResult`, and `OllamaFetchResult` values already collected by `collectAndPushProviderMetrics()`.
- Produces: `ProviderMetricsPushInput` with `ProviderResult[]`, an explicit empty health-metric array for this pre-registry foundation flow, and one shared push timestamp.

- [x] **Step 1: Use the existing scheduled-handler failures as the RED test**

Run:

```bash
npx vitest run tests/provider-metrics/scheduled.test.ts
```

Expected: the four push-related scenarios fail with `TypeError: results is not iterable`, proving the old object is being passed to the new builder.

- [x] **Step 2: Add the smallest typed conversion boundary**

Import `ProviderResult`, `QuotaPeriod`, and `QuotaWindow`. Convert each non-empty legacy result into its discriminated union member, converting OpenAI `tokens` to `modelUsage`, Codex reset seconds to absolute timestamps, OpenCodeGo reset seconds to timestamps relative to the shared push time, and Ollama session/weekly fields to quota windows. Pass:

```typescript
{
  results: providerResults,
  healthMetrics: [],
  nowUnixNano,
  nowSeconds,
}
```

Do not change the provider fetch APIs or the later registry-driven migration.

- [x] **Step 3: Run the focused tests**

Run:

```bash
npx vitest run tests/provider-metrics/scheduled.test.ts tests/provider-metrics/prometheus.test.ts
```

Expected: all focused tests pass and the existing metric names remain present in the scheduled payloads.

### Task 2: Run CI-equivalent verification

**Files:**
- Verify: `workers/src/provider-metrics.ts`
- Verify: `workers/tests/provider-metrics/scheduled.test.ts`

- [x] **Step 1: Run worker typecheck**

Run `npm run typecheck:ci` from `workers/` and expect exit code 0.

- [x] **Step 2: Run repository gates**

Run `make test`, `make typecheck`, `make fmt`, and `make validate` from the repository root. Record any pre-existing warning separately from failures.

- [x] **Step 3: Inspect the final diff and worktree**

Run `git diff --check`, `git diff --stat`, and `git status --short`. Confirm only the intended source/test/plan files changed and the pre-existing `.worktrees/` entry is untouched.
