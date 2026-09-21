# Task 12 Report: Scheduled Provider-Metrics Orchestration

## Result

Implemented the scheduled provider-metrics orchestration and wire-level
coverage for the five-provider registry:

- OpenAI history-day preflight and default handling.
- Registry-driven adapter execution through `runAdapters`.
- Diagnostic projection for skipped, success, empty, and failed executions.
- Health metrics for every attempted provider, including health-only pushes.
- Data-plus-health OTLP payload construction.
- OpenCode Go adapter wired through `./provider-metrics/opencodego/index`.
- Fixed diagnostic error allowlist: `statusCode`, `provider`, `sourceId`, and
  `kind`.

The scheduled test suite covers all required wire-level scenarios, including
invalid OpenAI configuration, partial provider failure, health-only pushes,
Ollama HTML fallback, zero-value metric preservation, and fixed diagnostic
projection.

## Verification

- `npx vitest run tests/provider-metrics/scheduled.test.ts` — 16 passed.
- `npm run typecheck` — passed.
- `npx prettier --check src/provider-metrics.ts tests/provider-metrics/scheduled.test.ts` — passed.
- `npm test` — 23 test files, 302 tests passed.
- LSP diagnostics were clean before the final formatting pass; the final
  refresh timed out, while TypeScript compilation remained successful.
- `GIT_MASTER=1 git diff --check` — passed.

## Scope

Changed only:

- `workers/src/provider-metrics.ts`
- `workers/tests/provider-metrics/scheduled.test.ts`
- This required task report.
