<!-- markdownlint-disable MD013 -->

# Cloudflare AI Gateway OTel Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenTelemetry observability path for Cloudflare AI Gateway that is independent of Logpush and proxy routing, protects credentials in payloads, exports canonical Tempo/Loki/Prometheus signals, and is reproducible with a self-hosted Grafana stack.

**Architecture:** Cloudflare AI Gateway sends OTLP/HTTP through Cloudflare Tunnel to a pinned custom Grafana Alloy distribution. Custom Alloy code owns ingress validation, fail-closed redaction, request-span election, deterministic sampling, branch-local fan-out, and bounded backend dispatch; stock components are used only where their contracts are sufficient. Tempo stores metadata, Loki stores redacted request payload logs, Prometheus stores unsampled request-span RED metrics, and a separate dashboard joins traces to Loki through `tracesToLogsV2`.

**Tech Stack:** Go custom Alloy distribution, Grafana Alloy/OpenTelemetry Collector components, Docker Compose, cloudflared, Grafana, Tempo, Loki, Prometheus, Node.js 22+ ESM contract tests, Vitest, shell tests, Make, and GitHub Actions.

## Global Constraints

- Existing Logpush Worker, proxy Worker, Tail Worker, and `grafana/dashboards/graft-ai-overview.json` remain unchanged.
- Free Plan OTel exporter availability and delivery of a real request span are a hard pre-implementation gate. Do not silently switch to paid features or make the proxy mandatory if the gate fails.
- `CLOUDFLARE_OTEL_EXPORT_ENCODING` is required and accepts only `protobuf` or `json`; the Cloudflare AI Gateway exporter management setting `content_type` must match it (`protobuf` → `content_type: "protobuf"`, `json` → `content_type: "json"`), and reference environments use `protobuf` and `application/x-protobuf`.
- Public ingress is exactly `/v1/traces`; unknown paths return `404`, content-type mismatch returns `415`, and non-identity compression returns `415`.
- `Authorization: Bearer ${OTEL_INGEST_TOKEN}` and backend credentials come only from secret files, environment variables, or Secrets Store. Never put credentials in source, dashboards, URLs, logs, or `*.tfvars`.
- Source metadata is trusted only when the TCP peer is in the explicit
  cloudflared-only `OTEL_TRUSTED_PROXY_CIDRS` set. Reject direct origins with
  `403/untrusted_source`, ignore all client forwarding headers except the
  Cloudflare-edge-overwritten `CF-Connecting-IP` on that trusted path, and use
  the shared `unknown` bucket when that header is absent or invalid.
- Redaction occurs before any exporter, debug log, or queue. Failed redaction drops only payload fields and records `payload_dropped=true` with `payload_drop_reason="redaction_failure"`.
- Sampling uses lowercase 32-character hex trace IDs, seed
  `graft-ai-otel-v1`, SHA-256 of `trace_id + seed`, and the first 8 bytes as a
  big-endian unsigned integer. Parse the configured decimal rate without
  floating point, reject values outside `0..1`, and convert it to integer ppm
  with `rate_ppm=floor(rate*1_000_000)`. Sample only when
  `hash*1_000_000 < rate_ppm*2^64`, using exact integer arithmetic and strict
  `<`; priority overrides are rejected.
- Spanmetrics receives selected request spans before sampling. Tempo and Loki use one trace-level decision; sampled-out traces appear in neither backend.
- Loki labels are only `model`, `status_code`, `env`, and `gateway`.
- Escaped Loki JSON lines are limited to `262144` bytes; truncation preserves UTF-8 boundaries, identity/numeric fields, and `[TRUNCATED]`.
- Receiver limits are 8 MiB, 5s header timeout, 30s read timeout, 10s write
  timeout, 100 concurrent requests, and a 1,000-item drop-new ingress queue.
  Source rate limiting uses the canonical source identity hash as its bucket
  key, capacity `20` tokens, refill `2` tokens/second (steady state
  `120 requests/minute`), and an `unknown` bucket when source metadata is
  unavailable. A rate-limited response is `429` with `Retry-After` as an ASCII
  decimal integer number of seconds, rounded up and at least `1`. An ingress
  queue overflow drops only the new item with fixed reason `capacity` and
  still returns `200`.
- Backend queues, retry, eviction, fixed drop reasons, and alerts follow spec §7.3 exactly.
- Self-hosted retention is Tempo `14d`, Loki `7d`, and Prometheus `14d`.
  Grafana Cloud payload export is enabled only when Cloud Logs retention is
  retrieved successfully and parses to a positive duration no greater than
  `14d`. Disable it for unavailable, failed, invalid, or over-`14d` results and
  record exactly one sanitized reason: `retention_unavailable`,
  `retention_lookup_failed`, `retention_invalid`, or
  `retention_exceeds_14d`.
- All container images use immutable digests. Never use `latest` or floating tags.
- Root contract and smoke scripts require Node.js 22 or newer and use only
  `.mjs`; do not rely on native TypeScript stripping, an implicit loader, or a
  nearest-package module-type lookup. CI remains pinned to Node.js 22.
- Run `make test`, `make typecheck`, and `make fmt` after TypeScript/configuration changes. Run `make validate` after Terraform changes.

---

## G0: Free Plan Feasibility and Ownership Gate

This is a prerequisite gate, not a PR. No implementation PR starts until it passes.

**Files:**

- Create: `docs/superpowers/acceptance/2026-08-17-ai-gateway-otel-feasibility.md`
- Create: `tests/fixtures/otel/README.md`
- Inspect: `docs/superpowers/specs/2026-08-16-ai-gateway-otel-observability-design.md`

**Produces:** A sanitized evidence record for Free Plan exporter availability, real protobuf delivery, `/v1/traces` preservation, and proxy/direct requests. It also records the decision to implement the bounded dispatcher inside custom Alloy so Alloy remains the sole fan-out owner. If a separate dispatcher image is required, amend spec §§3.1, 3.3, 6, and 7 before coding.

- [ ] **Step 1: Configure a non-secret test environment**

  Set `CLOUDFLARE_OTEL_EXPORT_ENCODING=protobuf`, apply the Cloudflare AI Gateway exporter management setting `content_type: "protobuf"`, and configure a temporary `OTEL_INGEST_TOKEN` and Tunnel endpoint outside tracked files. Record only status codes, endpoint shape, and safe identifiers.

- [ ] **Step 2: Read back the exporter setting and verify both request paths**

  Before sending telemetry, read back the exporter management setting and stop if `content_type` is not exactly `"protobuf"` or cannot be read back. Then send one request through the proxy Worker and one directly to AI Gateway. Confirm the exporter sends `application/x-protobuf`, the path remains `/v1/traces`, and a request-associated span arrives.

- [ ] **Step 3: Apply the hard stop rule**

  If the real Free Plan account cannot configure the exporter or deliver spans, stop and reopen the requirement. Do not replace the path with Logpush, paid features, or a mandatory proxy.

- [ ] **Step 4: Commit only sanitized evidence**

  ```bash
  git add docs/superpowers/acceptance/2026-08-17-ai-gateway-otel-feasibility.md tests/fixtures/otel/README.md
  git commit -m "docs: record AI Gateway OTel feasibility gate"
  ```

## Stacked PR Strategy

After G0, implement the work as **eight linear stacked PRs**. Each branch is based on the preceding branch so every review shows one layer. Do not implement everything on `master` and split it afterward.

Set the stack target once and reuse it for initialization and verification:

```bash
STACK_BASE=feature/cloudflare-ai-gateway-free-plan-observability__base
```

| PR | Branch | Base | Outcome |
| --- | --- | --- | --- |
| PR1 | `feat/otel-contracts` | `feature/cloudflare-ai-gateway-free-plan-observability__base` | Contract fixtures and test harness |
| PR2 | `feat/otel-custom-alloy-ingress` | `feat/otel-contracts` | Authenticated OTLP ingress, limits, HMAC identity, ingress queue |
| PR3 | `feat/otel-redaction-spanlogs` | `feat/otel-custom-alloy-ingress` | Redaction, projection, numeric validation, 256 KiB spanlogs |
| PR4 | `feat/otel-selection-sampling-metrics` | `feat/otel-redaction-spanlogs` | Request-span election, sampling, fan-out, canonical metrics |
| PR5 | `feat/otel-dispatcher-retry` | `feat/otel-selection-sampling-metrics` | Bounded backend queues, retry, eviction, drop metrics, alerts |
| PR6 | `feat/otel-compose-stack` | `feat/otel-dispatcher-retry` | Digest-pinned self-hosted stack and synthetic smoke test |
| PR7 | `feat/otel-grafana-dashboard` | `feat/otel-compose-stack` | OTel dashboard, provisioning, Recent Traces, trace-to-payload |
| PR8 | `feat/otel-acceptance-docs` | `feat/otel-grafana-dashboard` | CI/Make integration, Cloud acceptance, docs, compatibility checks |

```bash
gh stack init --base "$STACK_BASE" feat/otel-contracts
gh stack add feat/otel-custom-alloy-ingress
gh stack add feat/otel-redaction-spanlogs
gh stack add feat/otel-selection-sampling-metrics
gh stack add feat/otel-dispatcher-retry
gh stack add feat/otel-compose-stack
gh stack add feat/otel-grafana-dashboard
gh stack add feat/otel-acceptance-docs
gh stack submit --auto --open
gh stack view --json
```

Verify that the resulting JSON has
`trunk="feature/cloudflare-ai-gateway-free-plan-observability__base"`; do not
interpret `branches[].base` as a branch name because it is the saved parent SHA.

Merge in PR1 → PR2 → PR3 → PR4 → PR5 → PR6 → PR7 → PR8 order. After changing a lower branch, run `gh stack rebase --upstack`, then inspect `gh stack view --json`.

## File Structure Map

| Path | Responsibility |
| --- | --- |
| `deploy/otel/contracts/` | Shared encoding, status, sampling, metric, payload, and queue contract fixtures |
| `deploy/otel/alloy/` | Go custom Alloy distribution and focused unit tests |
| `deploy/otel/config/` | Alloy, Tempo, Loki, Prometheus, and Grafana provisioning |
| `deploy/otel/docker-compose.yml` | Local reference topology and persistent volumes |
| `deploy/otel/scripts/` | Synthetic OTLP and backend query smoke drivers |
| `deploy/otel/tests/` | Compose and resource-limit acceptance tests |
| `grafana/dashboards/graft-ai-otel.json` | OTel-only dashboard; never modify the existing dashboard |
| `tests/otel-*.test.mjs` | Root Node contract and dashboard regression tests |
| `docs/otel-*.md` | Operator setup, Cloud configuration, retention, and payload safety documentation |
| `docs/superpowers/acceptance/` | Sanitized real-account and final acceptance evidence |

Stock Alloy alone is insufficient for exact request-span election, recursive fail-closed redaction, fixed SHA-256 sampling, serialized-byte budgeting, and per-backend eviction. An external sidecar would move raw spans across an exporter boundary before redaction and weaken Alloy fan-out ownership. Therefore custom Go components are part of this plan.

---

## PR1: Contracts and Test Harness

**Files:**

- Create: `deploy/otel/contracts/encoding.mjs`
- Create: `deploy/otel/contracts/contracts.json`
- Create: `deploy/otel/contracts/sampling-fixtures.json`
- Create: `deploy/otel/contracts/README.md`
- Create: `tests/otel-contracts.test.mjs`
- Modify: `Makefile`, `README.md`
- Do not modify: `workers/src/**`, `grafana/dashboards/graft-ai-overview.json`

**Interfaces:**

- `resolveOtelEncoding(env): "protobuf" | "json"` rejects missing and unknown values.
- Fixtures define content types, receiver status/reason pairs, sampling
  decisions, canonical metrics, labels, queue limits, and all four fail-closed
  retention reasons. Retention fixtures enable payload export only for a valid
  positive Cloud Logs duration no greater than `14d`.

- [ ] **Step 1: Write failing Node contract tests**

  Assert encoding mappings and rejection, every
  `401/403/404/400/415/413/408/429/200` reason pair, exact decimal-to-ppm floor
  conversion, and all fixed sampling decisions from spec §2 for rates `0`,
  `0.000001`, `0.5`, and `1`.

- [ ] **Step 2: Run the focused test**

  ```bash
  node --test tests/otel-contracts.test.mjs
  ```

  Expected: FAIL because the module and fixtures do not exist.

- [ ] **Step 3: Implement dependency-free contracts**

  Implement `encoding.mjs` as dependency-free ESM and make JSON fixtures the
  source shared by later Go tests. Include no real endpoints, credentials,
  payloads, native TypeScript syntax, loaders, or absolute machine paths.

- [ ] **Step 4: Connect the test to Make**

  Add a Node.js `>=22` preflight and the Node test to `make test`, and add
  `make otel-contracts` for the focused run. Extend `make fmt` so the existing
  Workers-installed Prettier formats `deploy/otel/contracts/encoding.mjs` and
  `tests/otel-contracts.test.mjs`; `make typecheck` remains required for the
  existing strict Workers TypeScript scope.

- [ ] **Step 5: Verify and commit PR1**

  ```bash
  make otel-contracts
  make test
  make typecheck
  make fmt
  git add deploy/otel/contracts tests/otel-contracts.test.mjs Makefile README.md
  git commit -m "feat(otel): define ingress and sampling contracts"
  gh stack submit --auto --open
  ```

## PR2: Custom Alloy OTLP Ingress

**Files:**

- Create: `deploy/otel/alloy/go.mod`, `deploy/otel/alloy/go.sum`
- Create: `deploy/otel/alloy/cmd/alloy-otel/main.go`
- Create: `deploy/otel/alloy/internal/ingress/{receiver,auth,source_identity,queue,metrics,server}.go`
- Create: `deploy/otel/alloy/internal/ingress/*_test.go`
- Create: `deploy/otel/alloy/internal/ingress/server_integration_test.go`
- Create: `deploy/otel/alloy/Dockerfile`, `deploy/otel/alloy/Makefile`
- Modify: `deploy/otel/contracts/contracts.json`, `Makefile`

**Interfaces:**

- `Receiver.ServeHTTP(w, r)` validates path, bearer token, content type,
  identity encoding, body size, source bucket, and OTLP decoding. Server-level
  timeouts are owned only by `NewHTTPServer`.
- `NewHTTPServer(receiver) *http.Server` returns an `http.Server` with
  `ReadHeaderTimeout=5s`, `ReadTimeout=30s`, and `WriteTimeout=10s`, with
  `Receiver.ServeHTTP` as its handler.
- `IngressQueue.Enqueue(envelope) bool` implements atomic drop-new capacity 1,000 and asynchronous accepted `200` behavior.
- `SourceIdentity.Resolve(remoteAddr, headers)` rejects peers outside
  `OTEL_TRUSTED_PROXY_CIDRS`, ignores `X-Forwarded-For`, `True-Client-IP`, and
  other client forwarding headers, and accepts `CF-Connecting-IP` only from a
  trusted peer; absent or invalid trusted metadata resolves to `unknown`.
- `SourceIdentity.Hash(canonicalSource) string` loads its key from a secret
  file, environment variable, or Secrets Store, then computes
  `HMAC-SHA-256(key, "otel-ingress-source-v1\0" + canonical_ip)` and never logs
  raw IP.

- [ ] **Step 1: Write failing Go tests**

  Cover `/v1/traces`, unknown path, auth, JSON/protobuf, mismatch, compression,
  malformed payload, 8 MiB, timeout, trusted and untrusted remote peers,
  direct-origin `403/untrusted_source`, spoofed forwarding headers, missing
  source metadata and the `unknown` bucket, source rate-limit bucket key, capacity
  `20`, refill `2` tokens/second, `429`, integer-second `Retry-After`, 100
  concurrent requests, source normalization/HMAC, and capacity+1. Assert that
  ingress queue overflow uses drop reason `capacity` and returns `200`, while
  only source rate-limit overflow returns `429`.

  Add a real `net.Listen`/`http.Server` integration test that sends a slow
  header, slow request body, and blocked response writer. Assert the configured
  5s, 30s, and 10s server timeouts and the corresponding `408`/connection
  termination behavior; handler-only tests are not sufficient for these
  server-level limits.

- [ ] **Step 2: Run focused tests**

  ```bash
  cd deploy/otel/alloy
  go test ./internal/ingress/...
  ```

  Expected: FAIL because the custom receiver is not implemented.

- [ ] **Step 3: Implement receiver and queue**

  Reuse OTLP codecs, retain validation and queue ownership in custom Alloy,
  preserve `/v1/traces`, reject direct origins before source extraction, accept
  Cloudflare-edge-overwritten `CF-Connecting-IP` only from the configured
  cloudflared peer, discard all other forwarding headers, and construct the
  HTTP server through `NewHTTPServer` with the fixed timeout values.

- [ ] **Step 4: Build a pinned custom Alloy binary**

  Pin Go dependencies, build a static image, expose only the Tunnel-facing OTLP port, and keep backend ports internal.

- [ ] **Step 5: Verify and commit PR2**

  ```bash
  gofmt -w deploy/otel/alloy
  cd deploy/otel/alloy && go test ./...
  cd ../../.. && make test && make typecheck
  git add deploy/otel/alloy deploy/otel/contracts/contracts.json Makefile
  git commit -m "feat(otel): add authenticated bounded OTLP ingress"
  gh stack submit --auto --open
  ```

## PR3: Redaction and Spanlogs Projection

**Files:**

- Create: `deploy/otel/alloy/internal/redaction/{redactor,redactor_test}.go`
- Create: `deploy/otel/alloy/internal/spanlogs/{projector,projector_test,size,size_test}.go`
- Modify: `deploy/otel/alloy/internal/ingress/{receiver,queue}.go`
- Modify: `deploy/otel/contracts/contracts.json`

**Interfaces:**

- `Redactor.Redact(span) (RedactedSpan, RedactionStatus)` recursively masks credentials and removes only payload fields on failure.
- `Projector.ProjectRequestSpan(span) (JSONLogRecord, DropReason)` emits the allowlist only.
- `Sizer.Finalize(record) (JSONLogRecord, DropReason)` enforces post-escaping 256 KiB and returns `line_size_metadata` when metadata alone overflows.

- [ ] **Step 1: Write failing redaction tests**

  Cover Bearer, Basic, API key, nested JSON, explicit secret keys, known patterns, newline/quote/whitespace, and malformed payload fail-closed behavior.

- [ ] **Step 2: Write failing projection and size tests**

  Cover finite numbers, `numeric_field_invalid`, JSON escaping, exact 256 KiB, 50:50 and 100:0 budgets, UTF-8 boundaries, flags, fixed labels, and metadata-only drop.

- [ ] **Step 3: Implement redaction before queue handoff**

  Ensure raw spans never reach exporter, debug log, or queue. Preserve safe metadata and fixed drop reasons.

- [ ] **Step 4: Implement projection and finalization**

  Serialize after redaction and escaping, never split a record, and keep correlation fields out of labels.

- [ ] **Step 5: Verify and commit PR3**

  ```bash
  cd deploy/otel/alloy && go test ./...
  cd ../../.. && make test && make typecheck && make fmt
  git add deploy/otel/alloy deploy/otel/contracts/contracts.json
  git commit -m "feat(otel): redact and finalize spanlogs payloads"
  gh stack submit --auto --open
  ```

## PR4: Request-Span Election, Sampling, and Metrics

**Files:**

- Create: `deploy/otel/alloy/internal/selector/{request_span,request_span_test}.go`
- Create: `deploy/otel/alloy/internal/sampling/{sampler,sampler_test}.go`
- Create: `deploy/otel/alloy/internal/fanout/{branches,branches_test}.go`
- Create: `deploy/otel/alloy/internal/metrics/{canonical,canonical_test}.go`
- Modify: `deploy/otel/alloy/cmd/alloy-otel/main.go`, `deploy/otel/contracts/sampling-fixtures.json`

**Interfaces:**

- `RequestSelector.Add(span)`, `FlushIdle(now)`, and `Evict()` enforce 10,000 traces/64 MiB, the exact predicate/tie-break, idle 1s, and request flags.
- `Sampler.Decide(traceID string, ratePPM uint32) bool` implements fixed
  SHA-256 sampling with exact integer arithmetic and rejects values above
  `1_000_000` and all priority overrides.
- `FanOut.Trace(trace)` sends request spans to metrics before sampling and sampled branch-local copies to Tempo/Loki.
- `CanonicalMetrics.Normalize(requestSpan)` emits the three canonical names, permitted labels, and fixed histogram buckets.

- [ ] **Step 1: Write selector and sampling tests**

  Cover predicate candidates, ordering, idle flush, both limits, eviction
  reason, fixed hashes, decimal-to-ppm floor conversion without floating point,
  strict boundary comparison, rates `0`, `1`, `500000`, and `1000000` ppm, and
  sampled-out absence from both storage branches. Use a 128-bit comparison or
  equivalent checked integer arithmetic so the 64-bit hash is never rounded.

- [ ] **Step 2: Write fan-out and metrics tests**

  Use one root/request span plus child span. Assert no Tempo payload, identical redacted Loki payload, one metric contribution, and no child double count.

- [ ] **Step 3: Implement ordering and branch-local copies**

  Keep spanmetrics before sampling and never mutate a shared span after branching.

- [ ] **Step 4: Normalize metrics**

  Map span ERROR or HTTP status `>=400` to errors and use buckets `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, +Inf]`.

- [ ] **Step 5: Verify and commit PR4**

  ```bash
  cd deploy/otel/alloy && go test ./...
  cd ../../.. && make test && make typecheck
  git add deploy/otel/alloy deploy/otel/contracts/sampling-fixtures.json
  git commit -m "feat(otel): select request spans and sample traces deterministically"
  gh stack submit --auto --open
  ```

## PR5: Bounded Dispatcher, Retry, Eviction, and Alerts

**Files:**

- Create: `deploy/otel/alloy/internal/dispatcher/{dispatcher,backend_queue,retry,metrics,alerts}.go`
- Create: `deploy/otel/alloy/internal/dispatcher/*_test.go`
- Modify: `deploy/otel/alloy/cmd/alloy-otel/main.go`, `deploy/otel/contracts/contracts.json`

**Interfaces:**

- `Dispatcher.Handoff(envelope) HandoffResult` returns `accepted` or fixed `dropped(reason)` after redaction/serialization and never exposes backend health to Cloudflare.
- `BackendQueue.Enqueue(item)`, `Evict()`, and `OldestAge(now)` enforce backend byte/item limits and deterministic eviction.
- `RetryPolicy.Attempts(status/error)` implements three total attempts, retryable network/408/429/5xx classes, capped backoff, and ±20% jitter.

- [ ] **Step 1: Write failing queue tests**

  Cover Tempo 64 MiB/2,000 spans, Loki 64 MiB/500 records, Prometheus 16 MiB/100 batches, priorities, complete-trace eviction, fallback order, and backend independence.

- [ ] **Step 2: Write failing retry and alert tests**

  Cover attempt count, status classes, backoff range, metric timing, backend unhealthy ingress `200`, and all four five-minute alert thresholds.

- [ ] **Step 3: Implement one dispatcher owner**

  Do not enable stock retry or sending queues in parallel. Custom Alloy owns retries, drops, queues, and logical metrics.

- [ ] **Step 4: Verify and commit PR5**

  ```bash
  cd deploy/otel/alloy && go test ./...
  cd ../../.. && make test && make typecheck
  git add deploy/otel/alloy deploy/otel/contracts/contracts.json
  git commit -m "feat(otel): add bounded backend dispatcher and retry policy"
  gh stack submit --auto --open
  ```

## PR6: Digest-Pinned Self-Hosted Compose Stack

**Files:**

- Create: `deploy/otel/docker-compose.yml`
- Create: `deploy/otel/config/{alloy,tempo,loki,prometheus}.yaml`
- Create: `deploy/otel/config/grafana/provisioning/datasources/datasources.yaml`
- Create: `deploy/otel/config/grafana/provisioning/dashboards/dashboards.yaml`
- Create: `deploy/otel/env.example`
- Create: `deploy/otel/scripts/synthetic-otlp-smoke.mjs`
- Create: `deploy/otel/tests/compose-smoke.test.sh`
- Modify: `Makefile`, `.gitignore`

**Interfaces:**

- Compose publishes only Grafana as
  `127.0.0.1:${GRAFANA_PORT:-3000}:3000`. `cloudflared` opens an outbound Tunnel
  connection and publishes no host port; it reaches
  `http://alloy:4318/v1/traces` over the internal network. Alloy, Tempo, Loki,
  and Prometheus have no host bindings. Grafana disables anonymous access and
  reads its administrator password from a Compose secret file.
- `synthetic-otlp-smoke.mjs` runs in a profile-only one-shot `smoke` service,
  sends a redaction-safe OTLP protobuf trace to internal
  `http://alloy:4318/v1/traces`, and queries the internal Prometheus, Loki, and
  Tempo endpoints. It is a test helper, not one of the six production services.
- `compose-smoke.test.sh` is the only public smoke entrypoint. It creates
  temporary Grafana password, OTLP bearer token, and HMAC key files plus an
  ignored/generated `docker-compose.smoke.override.yml`, starts, health-checks,
  smokes, stops, and removes every generated file without writing secrets or
  state to tracked paths.

- [ ] **Step 1: Write the failing static Compose test**

  Assert exactly six production services exist (`grafana`, `alloy`, `tempo`,
  `loki`, `prometheus`, and `cloudflared`) plus one profile-only one-shot
  `smoke` helper, every image is digest-pinned, volumes and
  retention are explicit, the only host binding is Grafana on `127.0.0.1`,
  `cloudflared` and Alloy have no host bindings, Tempo/Loki/Prometheus cannot be
  reached from the host, Prometheus OTLP is enabled, Grafana anonymous access is
  disabled, and credentials are referenced through secret files rather than
  embedded. The bounded dispatcher is compiled into the custom Alloy service
  and is not a seventh Compose service.

- [ ] **Step 2: Write the synthetic smoke driver**

  Send one fixed trace, then assert canonical RED metrics, redacted Loki JSON, four Loki labels, and Tempo metadata without payload or credential-like attributes.

- [ ] **Step 3: Implement the reference stack**

  Configure custom Alloy, Tempo `14d`, Loki `7d`, Prometheus `14d` with OTLP
  receiver, Grafana datasources, cloudflared `/v1/traces` passthrough, volumes,
  and health checks. Bind only Grafana to host loopback, set
  `GF_AUTH_ANONYMOUS_ENABLED=false`, and set
  `GF_SECURITY_ADMIN_PASSWORD__FILE=/run/secrets/grafana_admin_password`; keep
  cloudflared, Alloy, and every backend free of host port bindings. Resolve
  actual image digests during implementation and record them in Compose.
  Put cloudflared on a dedicated internal subnet with a fixed service address
  and configure only that address in `OTEL_TRUSTED_PROXY_CIDRS`; reject
  `0.0.0.0/0`, `::/0`, the whole Compose subnet, and any host-facing CIDR in the
  static test. The no-external-credentials smoke profile uses an untracked/generated
  Compose override that adds only the one-shot smoke service address to the
  trusted set and must not be used for Tunnel acceptance.

- [ ] **Step 4: Run the empty-environment smoke test**

  ```bash
  bash deploy/otel/tests/compose-smoke.test.sh
  ```

  Expected: the script creates fresh local-only temporary secrets and an
  ignored override, passes both Compose files to every `up`, `run`, and `down`
  command, the five core services become healthy, the one-shot
  smoke service reaches all internal endpoints, the synthetic trace is
  queryable in all three backends, all temporary files are removed even after
  failure, and the sequence is repeatable. This flow requires no external
  credentials, does not start cloudflared, and does not claim Tunnel
  acceptance.

  Define cloudflared under a separate `tunnel` profile. Starting that profile
  requires a real Tunnel credential file and public hostname, validates the
  ingress configuration before connecting, and is used only by G0/PR8 manual
  acceptance. CI validates `docker compose --profile tunnel config` with
  placeholder secret-file paths but never opens a Tunnel.

- [ ] **Step 5: Add Make target and verify**

  Add `make otel-smoke` as a wrapper around
  `bash deploy/otel/tests/compose-smoke.test.sh`. Run `make test`,
  `make typecheck`, and `make fmt`.

- [ ] **Step 6: Commit and submit PR6**

  ```bash
  git add deploy/otel Makefile .gitignore
  git commit -m "feat(otel): add digest-pinned self-hosted reference stack"
  gh stack submit --auto --open
  ```

## PR7: Grafana OTel Dashboard

**Files:**

- Create: `grafana/dashboards/graft-ai-otel.json`
- Create: `grafana/provisioning/otel-datasources.yaml`
- Create: `grafana/provisioning/otel-dashboard.yaml`
- Create: `tests/otel-dashboard.test.mjs`
- Modify: `deploy/otel/config/grafana/provisioning/dashboards/dashboards.yaml`, `Makefile`
- Do not modify: `grafana/dashboards/graft-ai-overview.json`

**Interfaces:**

- Dashboard UID is `graft-ai-otel-observability`.
- PromQL uses only the three canonical metric families.
- LogQL uses JSON parsing with `unwrap` and `__error__=""` for input tokens, output tokens, and cost.
- Datasource UIDs are provisioned; Tempo `tracesToLogsV2` uses Loki UID, `filterByTraceID=true`, and `-5m/+5m` shifts.

- [ ] **Step 1: Write failing dashboard tests**

  Assert the separate UID, required panels, canonical queries, four Loki labels, no credential strings, no always-visible payload panel, datasource injection, sampling note, and unavailable-status mapping.

- [ ] **Step 2: Implement dashboard and provisioning**

  Add Total Requests, Error Rate, p50/p95 latency, input/output tokens, estimated cost, time series, model/provider breakdown, Recent Traces, sampling annotation, and trace-to-payload flow.

- [ ] **Step 3: Validate dashboard and regressions**

  ```bash
  node --test tests/otel-dashboard.test.mjs
  node scripts/deploy-dashboards.mjs --dry-run grafana/dashboards/graft-ai-otel.json
  make test
  make typecheck
  make fmt
  ```

  Expected: the new dashboard validates and the existing dashboard is unchanged.

- [ ] **Step 4: Commit and submit PR7**

  ```bash
  git add grafana/dashboards/graft-ai-otel.json grafana/provisioning tests/otel-dashboard.test.mjs deploy/otel/config/grafana Makefile
  git commit -m "feat(grafana): add AI Gateway OTel dashboard"
  gh stack submit --auto --open
  ```

## PR8: Acceptance Integration and Documentation

**Files:**

- Create: `docs/otel-self-hosted.md`
- Create: `docs/otel-grafana-cloud.md`
- Create: `docs/superpowers/acceptance/2026-08-17-ai-gateway-otel-acceptance.md`
- Create: `tests/otel-backward-compatibility.test.mjs`
- Create: `scripts/verify-otel-config.mjs`
- Modify: `README.md`, `Makefile`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `.gitignore`

**Interfaces:**

- `scripts/verify-otel-config.mjs` validates encoding, digest-only images, paths, retention, endpoint shape, and absence of inline credentials without production access.
- `tests/otel-backward-compatibility.test.mjs` verifies existing Logpush/proxy
  Worker fixtures, `workers/tests/tail-worker.test.ts`, Tail Worker source and
  Wrangler paths, dashboard JSON, and dashboard deployment defaults remain
  unchanged. Tail Worker assertions cover its fixed four labels, sorted Loki
  values, payload fields, empty-input behavior, and Loki push URL.
- The acceptance record contains sanitized results for all acceptance items, effective Cloud retention, and the custom Alloy image digest.

- [ ] **Step 1: Write failing static validation tests**

  Assert OTel files are isolated from Logpush, proxy, and Tail Worker paths;
  `workers/src/tail-worker.ts`, `workers/tests/tail-worker.test.ts`, and
  `workers/wrangler.tail.jsonc` are unchanged; the existing Tail Worker tests
  still produce the same Loki labels, sorted values, payload fields, empty-input
  behavior, and push URL; the existing dashboard is byte-for-byte unchanged; no
  secret files are tracked; and the Compose command path is exact.

- [ ] **Step 2: Implement operator documentation**

  Document secret injection, protobuf encoding, Compose/Tunnel setup, real
  requests, backend queries, proxy/direct verification, Grafana Cloud
  endpoint/auth replacement, and fail-closed Cloud Logs retention handling.
  Retrieval output, tenant URLs, and API response bodies must not appear in the
  sanitized reason record.

- [ ] **Step 3: Add local Make and CI gates**

  Add `make otel-validate` to `make test`. CI runs Node contracts, Go tests, static OTel validation, shellcheck, and Compose config validation without production credentials. Keep real-account acceptance manual and environment-gated.

- [ ] **Step 4: Add deployment integration**

  Extend deployment only with an explicit OTel validation/dashboard job or separately approved self-hosted deployment. Do not make existing Worker deployment depend on OTel and do not auto-deploy a Tunnel without environment approval.

- [ ] **Step 5: Run complete static verification**

  ```bash
  make otel-validate
  make test
  make typecheck
  make fmt
  make validate
  node --test tests/otel-backward-compatibility.test.mjs
  docker compose -f deploy/otel/docker-compose.yml config
  ```

- [ ] **Step 6: Perform real acceptance**

  Execute spec §8: Free Plan/protobuf, invalid status matrix, Tempo metadata, canonical metrics, same-trace redacted Loki payload, Recent Traces link, both sampling rates, retry/queue/alerts, backend outage `200`, oversized/slow/rate-limited requests, proxy/direct paths, credential absence, retention, and repeatable Compose up/smoke/down.

- [ ] **Step 7: Record sanitized evidence**

  Record self-hosted `14d/7d/14d`, actual Grafana Cloud Logs/Traces/Metrics retention, payload-export decision, and image digests. Exclude tokens, payload contents, credential-bearing URLs, and source IPs.

- [ ] **Step 8: Commit and submit PR8**

  ```bash
  git add docs/otel-self-hosted.md docs/otel-grafana-cloud.md docs/superpowers/acceptance/2026-08-17-ai-gateway-otel-acceptance.md tests/otel-backward-compatibility.test.mjs scripts/verify-otel-config.mjs README.md Makefile .github/workflows/ci.yml .github/workflows/deploy.yml .gitignore
  git commit -m "docs(otel): add acceptance and operating procedures"
  gh stack submit --auto --open
  ```

---

## Specification Coverage Matrix

| Specification area | Planned layer |
| --- | --- |
| §1 purpose and Free Plan independence | G0, PR8 |
| §2 encoding, sampling fixtures, Tunnel, payload protection | PR1, PR2, PR3, PR4 |
| §3.0 OTLP connection contract | PR1, PR2, PR6 |
| §3.1 redaction, selector, sampling, fan-out ownership | PR2, PR3, PR4, PR5 |
| §3.2 spanlogs allowlist, JSON, labels, sizing | PR3, PR7 |
| §3.3 backend endpoints, canonical metrics, retention | PR4, PR6, PR8 |
| §4 credential redaction | PR3, PR8 |
| §5 dashboard and trace-to-payload | PR7 |
| §6 Compose reproducibility | PR6, PR8 |
| §7.1 receiver limits, rate limits, ingress queue | PR2 |
| §7.2 redaction failures | PR3 |
| §7.3 retry, eviction, metrics, alerts | PR5 |
| §8 tests and acceptance | Every PR, especially PR6-PR8 |
| §9 boundaries and compatibility | PR8 |

Acceptance items 1-2 are blocked by G0; items 3-7 are covered by PR3/PR4/PR6/PR7; items 8-10 by PR2/PR5/PR6; items 11-15 by PR6/PR8.

## Self-Review Checklist

- [ ] Every spec section is mapped above.
- [ ] Every behavior has named files, interfaces, tests, and commands.
- [ ] The custom Alloy decision and rejected sidecar boundary are explicit.
- [ ] Eight linear PRs have branch/base names and `gh stack` commands.
- [ ] No unnamed dependency, tracked secret, floating image, or unspecified backend remains.
- [ ] Existing Worker, proxy, Logpush, Tail Worker, Terraform, and dashboard behavior has regression protection.
- [ ] Markdown lint and path checks pass before handoff.
