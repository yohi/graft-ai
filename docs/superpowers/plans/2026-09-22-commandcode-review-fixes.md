# CommandCode Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct CommandCode JSON body-read retry classification, subscription provenance, and required-credits short-circuiting without changing the shared raw `Response` contract.

**Architecture:** Keep `getWithRetry()` unchanged for callers that consume raw JSON or text responses. Add a JSON-specific retry helper in `workers/src/http-retry.ts` that parses successful responses inside each attempt, retries only body-read `AbortError` and `TimeoutError`, and rethrows syntax or other body-read errors. Use that helper only from CommandCode billing requests; update the adapter provenance and required-credits flow in place.

**Tech Stack:** TypeScript 5.9, Vitest 4, Cloudflare Workers Fetch APIs, npm scripts under `workers/`.

## Global Constraints

- Preserve the existing `getWithRetry()` raw `Response` behavior for all current callers.
- Retry up to the existing default attempt count and backoff policy.
- Classify body-read `AbortError` and `TimeoutError` as `timeout` after retry exhaustion.
- Preserve JSON `SyntaxError` as `parse` and other body-read exceptions as `internal` in CommandCode.
- Never expose response bodies, credentials, or raw exception messages in provider outcomes.
- Keep subscription, summary, and credits source IDs unchanged.
- Do not stage the pre-existing untracked `.worktrees/` directory.

---

### Task 1: Add JSON body-read retry coverage

**Files:**

- Modify: `workers/tests/http-retry.test.ts`
- Test: `workers/tests/http-retry.test.ts`

**Interfaces:**

- Consumes: `getJsonWithRetry` from `../src/http-retry` after the implementation is added.
- Produces: Regression coverage proving body-read timeout retry, syntax-error no-retry, and other-error no-retry behavior.

- [ ] **Step 1: Add a failing timeout-body test**

Add a test that returns a 200 response whose first `json()` call rejects with `DOMException(..., "TimeoutError")`, then returns a valid JSON response. Assert the helper returns the second body and the fetch function is called twice.

- [ ] **Step 2: Add failing no-retry body-error tests**

Add tests that make `json()` reject with `SyntaxError` and an ordinary `Error`. Assert each rejection is propagated and the fetch function is called once.

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```bash
npx vitest run tests/http-retry.test.ts
```

Expected: the new tests fail because `getJsonWithRetry` does not yet exist.

### Task 2: Implement JSON body-read retry helper

**Files:**

- Modify: `workers/src/http-retry.ts`

**Interfaces:**

- Consumes: Existing `GetWithRetryOptions`, `HttpTransportError`, retry constants, and timeout classification.
- Produces: `getJsonWithRetry(options: GetWithRetryOptions): Promise<{ response: Response; body: unknown }>`.

- [ ] **Step 1: Extract the shared timeout-name predicate**

Use one predicate for fetch failures and JSON body-read failures:

```typescript
function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
```

Keep the existing network/timeout logging and `HttpTransportError` behavior unchanged.

- [ ] **Step 2: Implement `getJsonWithRetry`**

For each attempt, fetch with the same options as `getWithRetry`. Return non-OK responses without consuming their bodies so the caller can classify status and cancel the body. For an OK response, call `response.json()` inside the attempt. Retry only when that call rejects with `AbortError` or `TimeoutError`; after the final such failure throw `HttpTransportError("timeout")`. Rethrow `SyntaxError` and all other body-read errors immediately. Preserve existing retryable HTTP status handling and exponential backoff.

- [ ] **Step 3: Run focused tests and confirm green**

Run:

```bash
npx vitest run tests/http-retry.test.ts
```

Expected: all HTTP retry tests pass.

### Task 3: Add CommandCode regression tests

**Files:**

- Modify: `workers/tests/provider-metrics/commandcode.test.ts`

**Interfaces:**

- Consumes: `commandcodeAdapter`, endpoint helpers, and existing route fixtures.
- Produces: Regression coverage for the three reviewed CommandCode behaviors.

- [ ] **Step 1: Add a current-period-start-only provenance case**

Return a subscription body containing only a valid `currentPeriodStart`. Assert the summary URL includes the encoded `since` value and the successful result includes `commandcode-billing-subscriptions` before the summary source.

- [ ] **Step 2: Add a credits-failure short-circuit case**

Make the credits endpoint fail and make the summary route throw if called. Assert the adapter returns the credits error and the summary route is never invoked.

- [ ] **Step 3: Add a body-timeout retry case**

Return a 200 credits response whose first `json()` call rejects with `AbortError` or `TimeoutError`, then return a valid credits response. Assert the adapter succeeds and the endpoint was fetched twice. Use the existing fake-timer helper for retry backoff.

- [ ] **Step 4: Run the CommandCode tests and confirm failure**

Run:

```bash
npx vitest run tests/provider-metrics/commandcode.test.ts
```

Expected: the new assertions fail before the adapter changes are applied.

### Task 4: Apply the CommandCode fixes

**Files:**

- Modify: `workers/src/provider-metrics/commandcode/billing.ts:1-122`
- Modify: `workers/src/provider-metrics/commandcode/index.ts:29-98`

**Interfaces:**

- Consumes: `getJsonWithRetry`, `CommandCodeSubscription`, and existing endpoint outcomes.
- Produces: Correct timeout classification/retry, subscription provenance, and required-credits short-circuit behavior.

- [ ] **Step 1: Use JSON retry in `requestEndpoint`**

Replace the raw `getWithRetry` call and later `response.json()` call with `getJsonWithRetry`. Keep non-OK HTTP classification and `jsonFailureKind` mapping unchanged; the helper must surface exhausted body timeouts as `HttpTransportError("timeout")`.

- [ ] **Step 2: Include `currentPeriodStart` in subscription contribution detection**

Extend `subscriptionContributes` with `subscription.currentPeriodStart !== undefined` while preserving the existing plan, status, and billing-period-end checks.

- [ ] **Step 3: Short-circuit credits failure before summary**

Immediately after the `Promise.all` for credits and subscription, return `{ status: "failed", error: credits.error }` when `credits.ok` is false. Leave summary invocation and success result construction unchanged for successful credits.

- [ ] **Step 4: Run focused tests and confirm green**

Run:

```bash
npx vitest run tests/http-retry.test.ts tests/provider-metrics/commandcode.test.ts
```

Expected: all focused tests pass.

### Task 5: Verify the repository changes

**Files:**

- Verify: `workers/src/http-retry.ts`
- Verify: `workers/src/provider-metrics/commandcode/billing.ts`
- Verify: `workers/src/provider-metrics/commandcode/index.ts`
- Verify: `workers/tests/http-retry.test.ts`
- Verify: `workers/tests/provider-metrics/commandcode.test.ts`

**Interfaces:**

- Consumes: Focused implementation and regression tests.
- Produces: Evidence that the complete Workers test suite, type checker, and diff checks pass.

- [ ] **Step 1: Run the complete Workers test suite**

Run `npm test` from `workers/`; expect every test file and test case to pass.

- [ ] **Step 2: Run the Workers type checker**

Run `npm run typecheck` from `workers/`; expect exit code 0.

- [ ] **Step 3: Check formatting and worktree scope**

Run `npx prettier --check src/http-retry.ts src/provider-metrics/commandcode/billing.ts src/provider-metrics/commandcode/index.ts tests/http-retry.test.ts tests/provider-metrics/commandcode.test.ts` from `workers/`, then run `git diff --check` and `git status --short`. Confirm only intended tracked files plus the pre-existing `.worktrees/` entry are present.

### Task 6: Commit and push the verified fix

**Files:**

- Commit: `docs/superpowers/plans/2026-09-22-commandcode-review-fixes.md`
- Commit: `workers/src/http-retry.ts`
- Commit: `workers/src/provider-metrics/commandcode/billing.ts`
- Commit: `workers/src/provider-metrics/commandcode/index.ts`
- Commit: `workers/tests/http-retry.test.ts`
- Commit: `workers/tests/provider-metrics/commandcode.test.ts`

**Interfaces:**

- Consumes: Verified working-tree diff and current branch tracking configuration.
- Produces: Separate Japanese Conventional Commits for the plan and implementation, both pushed to the current remote tracking branch.

- [ ] **Step 1: Inspect branch and diff before staging**

Run `git status --short`, `git diff --stat`, `git diff`, `git branch --show-current`, and `git status --short --branch`. Do not stage `.worktrees/` or unrelated files.

- [ ] **Step 2: Commit the plan separately**

Stage only the plan and commit with:

```bash
git add docs/superpowers/plans/2026-09-22-commandcode-review-fixes.md
git commit -m "docs: CommandCodeレビュー対応計画を追加"
```

- [ ] **Step 3: Commit only intended implementation files**

Stage the five implementation/test files and commit with:

```bash
git commit -m "fix(provider-metrics): CommandCodeの再試行と失敗フローを修正"
```

- [ ] **Step 4: Push the current branch**

Push to its configured upstream with `git push`; do not force-push and do not merge any pull request.

- [ ] **Step 5: Verify the pushed commits**

Run `git status --short --branch` and `git log --oneline -1`; expect the branch to be up to date with its remote and the new commit to be the latest commit.
