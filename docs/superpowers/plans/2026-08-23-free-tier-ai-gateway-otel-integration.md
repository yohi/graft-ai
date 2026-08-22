# Free Tier AI Gateway OTel Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Do not use subagents; steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Cloudflare AI Gateway OpenTelemetry data through the existing authenticated Alloy receiver so Free Tier deployments produce redacted Tempo traces, Loki request logs, and Prometheus RED metrics.

**Architecture:** Keep the existing proxy Worker, Cloudflare Tunnel, custom Alloy receiver, and Grafana Cloud backends. The proxy injects fixed low-cardinality `gateway` and `env` metadata into every AI Gateway request; Alloy normalizes Cloudflare GenAI semantic-convention attributes before redaction and fan-out. A Cloudflare Gateway exporter sends OTLP/protobuf to the Tunnel endpoint rather than directly to Grafana Cloud, ensuring raw request payloads do not bypass Alloy redaction.

**Tech Stack:** TypeScript Cloudflare Workers with Vitest, Go custom Alloy receiver with Go tests, Docker Compose, Cloudflare AI Gateway and Tunnel, Grafana Cloud Tempo/Loki/Prometheus, Node.js test runner.

## Global Constraints

- Do not use Workers Logpush, Tail Workers, or the Logpush Terraform workspace for this Free Tier integration.
- Receive authenticated OTLP/HTTP only on `POST /v1/traces` through the Cloudflare Tunnel; Alloy must continue to trust only `172.30.0.10/32`.
- Keep Loki labels strictly limited to `model`, `status_code`, `env`, and `gateway`; provider and trace ID remain log fields or Prometheus labels only.
- Never commit or print Cloudflare tunnel tokens, Alloy ingest/HMAC secrets, Grafana endpoint authorization headers, provider API keys, or generated environment files.
- Keep Grafana Cloud payload-log export disabled unless the confirmed Logs retention is a positive duration of 14 days or less.
- Replace the existing direct AI Gateway-to-Grafana OTLP exporter after Alloy is live; do not retain it as a parallel exporter because it bypasses redaction and duplicates traces.
- Preserve the existing self-hosted Compose defaults and the existing `graft-ai-otel-observability` dashboard UID.
- Validate code with focused tests first, then run `make test`, `make typecheck`, `make fmt`, `make validate`, `make otel-validate`, and `make otel-smoke` before production activation.
- Do not create or modify agent configuration files.

---

## File Structure

| File                                                   | Responsibility                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `workers/src/proxy.ts`                                 | Add trusted `gateway` and `env` metadata to the request forwarded to AI Gateway.                                            |
| `workers/tests/proxy.test.ts`                          | Prove metadata is injected, fixed labels override caller values, and malformed caller metadata is replaced safely.          |
| `deploy/otel/alloy/internal/ingress/decode.go`         | Normalize Cloudflare's `gen_ai.model.provider` attribute to the canonical `provider` field.                                 |
| `deploy/otel/alloy/internal/ingress/decode_test.go`    | Verify OTLP/protobuf Cloudflare attributes become canonical attributes consumed by the selector and fan-out.                |
| `deploy/otel/alloy/internal/metrics/canonical.go`      | Preserve the Cloudflare provider attribute as a direct fallback when normalization was not performed first.                 |
| `deploy/otel/alloy/internal/metrics/canonical_test.go` | Verify generated RED metrics use the real provider instead of `unknown`.                                                    |
| `deploy/otel/docker-compose.grafana-cloud.yml`         | Require the verified Grafana Cloud Logs retention value in Cloud mode so Loki fan-out is intentionally enabled.             |
| `deploy/otel/env.example`                              | Document the required non-secret retention setting for the Cloud Compose override.                                          |
| `tests/otel-cloud-config.test.mjs`                     | Lock the Cloud Compose retention contract and ensure secrets remain external.                                               |
| `deploy/otel/scripts/synthetic-otlp-smoke.mjs`         | Exercise the actual Cloudflare GenAI attribute names and assert redacted Loki output in the local three-backend smoke test. |
| `tests/otel-smoke-retry.test.mjs`                      | Verify the smoke driver sends the Cloudflare attribute contract and rejects an unredacted or incomplete Loki record.        |
| `docs/free-tier-ai-gateway-otel.md`                    | Provide the production host, Tunnel, AI Gateway exporter, and Grafana verification runbook.                                 |
| `README.md` and `README.ja.md`                         | Link the Free Tier OTel runbook and distinguish it from the Logpush-only overview dashboard.                                |
| `tests/deployment-contracts.test.mjs`                  | Ensure the runbook remains linked and includes the required non-secret deployment interface.                                |

No changes are planned for `terraform/main.tf`, Logpush Workers, or `.github/workflows/deploy.yml`: the Alloy host and Cloudflare Tunnel are long-running runtime infrastructure, not GitHub Actions deployment targets.

## Task 1: Inject Stable OTel Labels at the Proxy Boundary

**Files:**

- Modify: `workers/src/proxy.ts`
- Modify: `workers/tests/proxy.test.ts`

**Interfaces:**

- Consumes: `ProxyEnv.GATEWAY_NAME`, `ProxyEnv.ENV_LABEL`, and any caller-provided `cf-aig-metadata` header.
- Produces: `buildUpstreamInit(request: Request, env: ProxyEnv): RequestInit`, which sends a JSON-object `cf-aig-metadata` header containing the configured `gateway` and `env` values.
- Guarantees: caller values for `gateway` and `env` cannot change Loki label cardinality; unrelated valid caller metadata remains intact.

- [ ] **Step 1: Add failing proxy metadata tests**

Add these tests to `workers/tests/proxy.test.ts`. Reuse the existing mocked `fetch` and `buildEnv()` helpers.

```ts
it("injects configured gateway and environment metadata while preserving other metadata", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const request = new Request(
    "https://proxy.example.com/openai/chat/completions",
    {
      method: "POST",
      headers: {
        "x-proxy-secret": "test-proxy-secret",
        "cf-aig-metadata": '{"tenant":"team-a","gateway":"caller","env":"dev"}',
      },
      body: "{}",
    },
  );

  await proxyWorker.fetch?.(
    request,
    buildEnv(),
    mockCtx as unknown as ExecutionContext,
  );

  const [, init] = fetchSpy.mock.calls[0] ?? [];
  const metadata = JSON.parse(
    new Headers(init?.headers).get("cf-aig-metadata") ?? "{}",
  );
  expect(metadata).toEqual({ tenant: "team-a", gateway: "main", env: "prod" });
  expect(new Headers(init?.headers).get("x-proxy-secret")).toBeNull();
});

it("replaces malformed caller metadata with the configured labels", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const request = new Request(
    "https://proxy.example.com/openai/chat/completions",
    {
      method: "POST",
      headers: {
        "x-proxy-secret": "test-proxy-secret",
        "cf-aig-metadata": "not-json",
      },
      body: "{}",
    },
  );

  await proxyWorker.fetch?.(
    request,
    buildEnv(),
    mockCtx as unknown as ExecutionContext,
  );

  const [, init] = fetchSpy.mock.calls[0] ?? [];
  expect(
    JSON.parse(new Headers(init?.headers).get("cf-aig-metadata") ?? "{}"),
  ).toEqual({
    gateway: "main",
    env: "prod",
  });
});
```

- [ ] **Step 2: Run the focused Worker test and confirm it fails**

Run:

```bash
cd workers && npx vitest run tests/proxy.test.ts
```

Expected: the new tests fail because the upstream request currently forwards the caller header unchanged or omits the header.

- [ ] **Step 3: Implement metadata injection without changing proxy routing**

In `workers/src/proxy.ts`, add a JSON-object parser and change `buildUpstreamInit` to accept `env`. Preserve valid non-reserved metadata, discard malformed/non-object metadata, and always overwrite `gateway` and `env` with the configured values.

```ts
function isMetadataObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataForGateway(rawMetadata: string | null, env: ProxyEnv): string {
  let metadata: Record<string, unknown> = {};
  if (rawMetadata !== null) {
    try {
      const parsed: unknown = JSON.parse(rawMetadata);
      if (isMetadataObject(parsed)) metadata = parsed;
    } catch {
      metadata = {};
    }
  }
  return JSON.stringify({
    ...metadata,
    gateway: env.GATEWAY_NAME,
    env: env.ENV_LABEL,
  });
}

function buildUpstreamInit(request: Request, env: ProxyEnv): RequestInit {
  const headers = new Headers(request.headers);
  headers.delete("X-Proxy-Secret");
  headers.set(
    "cf-aig-metadata",
    metadataForGateway(headers.get("cf-aig-metadata"), env),
  );
  // Keep the existing GET/HEAD and streaming-body branches unchanged.
}
```

Update the single forwarding call to use `buildUpstreamInit(request, env)`. Do not add `gateway` or `env` as Loki labels in the Worker; AI Gateway returns these metadata keys as trace attributes and Alloy projects them into its existing fixed label set.

- [ ] **Step 4: Run Worker validation**

Run:

```bash
cd workers && npx vitest run tests/proxy.test.ts
cd workers && npm run typecheck:ci
```

Expected: the focused Vitest suite and strict TypeScript check pass; the upstream request still preserves authorization, body, path, and non-reserved metadata.

- [ ] **Step 5: Format the changed TypeScript files**

Run:

```bash
cd workers && npx prettier --write src/proxy.ts tests/proxy.test.ts
```

Expected: Prettier reports both files as formatted without changing runtime semantics.

- [ ] **Step 6: Create the commit only if a later user instruction explicitly requests a commit**

```bash
git add workers/src/proxy.ts workers/tests/proxy.test.ts
git commit -m "feat(proxy): OTelメタデータへ固定ラベルを追加"
```

## Task 2: Normalize Cloudflare Provider Semantic Conventions

**Files:**

- Modify: `deploy/otel/alloy/internal/ingress/decode.go`
- Modify: `deploy/otel/alloy/internal/ingress/decode_test.go`
- Modify: `deploy/otel/alloy/internal/metrics/canonical.go`
- Modify: `deploy/otel/alloy/internal/metrics/canonical_test.go`

**Interfaces:**

- Consumes: Cloudflare span attribute `gen_ai.model.provider` as documented by AI Gateway OTel.
- Produces: canonical `provider` attributes and `ai_gateway_*{provider="<provider>"}` metric labels.
- Guarantees: existing `provider`, `gen_ai.provider.name`, and `gen_ai.system` precedence remains unchanged; `gen_ai.model.provider` is used only when a higher-priority value is absent.

- [ ] **Step 1: Add a failing ingress normalization test**

Add OTLP attribute helpers and a test in `deploy/otel/alloy/internal/ingress/decode_test.go` that marshals one server span with Cloudflare's attributes.

```go
func TestDecodeSpans_normalizesCloudflareGenAIProvider(t *testing.T) {
	payload := requestSpanOTLPBody(t, []*commonpb.KeyValue{
		stringAttribute("gen_ai.request.model", "gpt-4o-mini"),
		stringAttribute("gen_ai.model.provider", "openai"),
		intAttribute("http.response.status_code", 200),
		stringAttribute("gateway", "main"),
		stringAttribute("env", "prod"),
	})

	spans, err := decodeSpans(payload, "application/x-protobuf")
	if err != nil {
		t.Fatalf("decodeSpans() error = %v", err)
	}
	for key, want := range map[string]string{
		"model": `"gpt-4o-mini"`, "provider": `"openai"`,
		"status_code": "200", "gateway": `"main"`, "env": `"prod"`,
	} {
		if got := string(spans[0].Attributes[key]); got != want {
			t.Fatalf("%s = %s, want %s", key, got, want)
		}
	}
}
```

Implement `requestSpanOTLPBody`, `stringAttribute`, and `intAttribute` in the same test file using the existing `collectortracepb`, `commonpb`, `tracepb`, and `proto` imports. The helper must create a valid 16-byte trace ID, 8-byte span ID, and `SPAN_KIND_SERVER` span.

- [ ] **Step 2: Run the focused ingress test and confirm it fails**

Run:

```bash
(cd deploy/otel/alloy && go test -race -shuffle=on -count=1 -run TestDecodeSpans_normalizesCloudflareGenAIProvider ./internal/ingress)
```

Expected: FAIL because `provider` is absent; `decode.go` currently recognizes only `gen_ai.provider.name` and `gen_ai.system`.

- [ ] **Step 3: Add the provider alias at both normalization boundaries**

Change the provider alias list in `decode.go` and the fallback sequence in `canonical.go` to include `gen_ai.model.provider` immediately after the canonical `provider` key.

```go
{canonical: "provider", aliases: []string{"gen_ai.model.provider", "gen_ai.provider.name", "gen_ai.system"}},
```

```go
"provider": firstString(span, "provider", "gen_ai.model.provider", "gen_ai.provider.name", "gen_ai.system"),
```

Do not alter the model, status, token, cost, gateway, or environment aliases.

- [ ] **Step 4: Add a direct canonical-metrics fallback test**

Add this test to `deploy/otel/alloy/internal/metrics/canonical_test.go`.

```go
func TestCanonicalMetrics_usesCloudflareProviderFallback(t *testing.T) {
	span := redaction.RedactedSpan{Span: redaction.Span{Attributes: map[string]json.RawMessage{
		"graft_ai.request_span": raw(`true`),
		"gen_ai.model.provider": raw(`"openai"`),
	}}}

	normalized := NewCanonicalMetrics().Normalize(span)
	if got := normalized.Samples[0].Labels["provider"]; got != "openai" {
		t.Fatalf("provider = %q, want openai", got)
	}
}
```

- [ ] **Step 5: Run focused and package-level Go tests**

Run:

```bash
(cd deploy/otel/alloy && go test -race -shuffle=on -count=1 -run "TestDecodeSpans_normalizesCloudflareGenAIProvider|TestCanonicalMetrics_usesCloudflareProviderFallback" ./internal/ingress ./internal/metrics)
make -C deploy/otel/alloy test
```

Expected: both focused tests pass and the full Go race-enabled test suite remains green.

- [ ] **Step 6: Format the changed Go files**

Run:

```bash
gofmt -w deploy/otel/alloy/internal/ingress/decode.go deploy/otel/alloy/internal/ingress/decode_test.go deploy/otel/alloy/internal/metrics/canonical.go deploy/otel/alloy/internal/metrics/canonical_test.go
```

Expected: `gofmt` writes canonical formatting only.

- [ ] **Step 7: Create the commit only if a later user instruction explicitly requests a commit**

```bash
git add deploy/otel/alloy/internal/ingress/decode.go deploy/otel/alloy/internal/ingress/decode_test.go deploy/otel/alloy/internal/metrics/canonical.go deploy/otel/alloy/internal/metrics/canonical_test.go
git commit -m "fix(otel): Cloudflare provider属性を正規化"
```

## Task 3: Require Confirmed Cloud Logs Retention in Grafana Cloud Mode

**Files:**

- Modify: `deploy/otel/docker-compose.grafana-cloud.yml`
- Modify: `deploy/otel/env.example`
- Modify: `tests/otel-cloud-config.test.mjs`

**Interfaces:**

- Consumes: non-secret `OTEL_GRAFANA_CLOUD_LOGS_RETENTION`, expressed as a positive Go-style duration such as `14d`.
- Produces: the same variable inside the Alloy container when the Grafana Cloud Compose override is used.
- Guarantees: a Cloud Loki URL cannot silently disable payload-log fan-out because the retention variable was present only in the host shell.

- [ ] **Step 1: Add a failing Cloud Compose contract assertion**

Extend the `Grafana Cloud Compose override requires external endpoints and auth headers` test in `tests/otel-cloud-config.test.mjs`.

```js
assert.match(
  compose,
  /\$\{OTEL_GRAFANA_CLOUD_LOGS_RETENTION:\?set the confirmed Grafana Cloud Logs retention to a positive duration of 14d or less\}/,
);
```

- [ ] **Step 2: Run the focused contract test and confirm it fails**

Run:

```bash
node --test tests/otel-cloud-config.test.mjs
```

Expected: FAIL because the Cloud override currently does not pass the retention value into the Alloy container.

- [ ] **Step 3: Make retention an explicit Cloud-mode container environment variable**

Add this key beneath the existing Alloy environment entries in `deploy/otel/docker-compose.grafana-cloud.yml`.

```yaml
OTEL_GRAFANA_CLOUD_LOGS_RETENTION: ${OTEL_GRAFANA_CLOUD_LOGS_RETENTION:?set the confirmed Grafana Cloud Logs retention to a positive duration of 14d or less}
```

Update `deploy/otel/env.example` so the retention entry says it is required with the Grafana Cloud override and shows `14d` only as an example after confirming the stack's effective Logs retention.

- [ ] **Step 4: Validate both Compose modes with non-secret values**

Run:

```bash
node --test tests/otel-cloud-config.test.mjs
docker compose -f deploy/otel/docker-compose.yml config >/dev/null
env OTEL_TEMPO_URL=https://tempo.example.net/otlp/v1/traces OTEL_TEMPO_AUTHORIZATION='Basic test' OTEL_LOKI_URL=https://logs.example.net/loki/api/v1/push OTEL_LOKI_AUTHORIZATION='Basic test' OTEL_PROMETHEUS_URL=https://metrics.example.net/otlp/v1/metrics OTEL_PROMETHEUS_AUTHORIZATION='Basic test' OTEL_GRAFANA_CLOUD_LOGS_RETENTION=14d docker compose -f deploy/otel/docker-compose.yml -f deploy/otel/docker-compose.grafana-cloud.yml config >/dev/null
```

Expected: the contract test and both Compose parses pass without real endpoint credentials or secret values.

- [ ] **Step 5: Create the commit only if a later user instruction explicitly requests a commit**

```bash
git add deploy/otel/docker-compose.grafana-cloud.yml deploy/otel/env.example tests/otel-cloud-config.test.mjs
git commit -m "fix(otel): Cloud Loki保持期間を明示的に要求"
```

## Task 4: Exercise the Cloudflare Contract Through the Full Local Fan-out

**Files:**

- Modify: `deploy/otel/scripts/synthetic-otlp-smoke.mjs`
- Modify: `tests/otel-smoke-retry.test.mjs`

**Interfaces:**

- Consumes: OTLP/JSON trace input with Cloudflare's `gen_ai.request.model`, `gen_ai.model.provider`, `gen_ai.usage.*`, `http.response.status_code`, `gateway`, and `env` attributes.
- Produces: one canonical Prometheus request metric, one redacted Loki record with the four allowed labels, and one Tempo trace with the known trace ID.
- Guarantees: the smoke driver rejects output containing `sk-live-smoke`, accepts only a Loki record with canonical token/cost/provider fields, and retains the existing retry semantics.

- [ ] **Step 1: Strengthen the Node smoke-driver test first**

In `tests/otel-smoke-retry.test.mjs`, capture the POST body at `/v1/traces`, return a structured Loki record, and assert the driver sent Cloudflare attribute names.

```js
let submittedTrace;

if (request.method === "POST" && request.url === "/v1/traces") {
  submittedTrace = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  response.end(JSON.stringify({ reason: "accepted" }));
  return;
}

assert.ok(
  submittedTrace.resourceSpans[0].scopeSpans[0].spans[0].attributes.some(
    ({ key }) => key === "gen_ai.model.provider",
  ),
);
```

Make the mocked Loki response contain a JSON line with `provider`, `input_tokens`, `output_tokens`, `total_tokens`, `cost_usd`, a prompt containing `[REDACTED]`, and no `sk-live-smoke` value.

- [ ] **Step 2: Run the Node smoke-driver test and confirm it fails**

Run:

```bash
node --test tests/otel-smoke-retry.test.mjs
```

Expected: FAIL because the smoke driver currently posts canonical `model` and `provider` attributes and accepts any Loki stream with `gateway="smoke"`.

- [ ] **Step 3: Change the synthetic span to the Cloudflare attribute contract**

Replace the canonical identity and usage attributes in `deploy/otel/scripts/synthetic-otlp-smoke.mjs` with these values while retaining the current deterministic IDs and server span kind.

```js
{ key: "gen_ai.request.model", value: { stringValue: "smoke-model" } },
{ key: "gen_ai.model.provider", value: { stringValue: "smoke-provider" } },
{ key: "gen_ai.usage.input_tokens", value: { intValue: "12" } },
{ key: "gen_ai.usage.output_tokens", value: { intValue: "7" } },
{ key: "gen_ai.usage.total_tokens", value: { intValue: "19" } },
{ key: "gen_ai.usage.cost", value: { doubleValue: 0.0125 } },
{ key: "http.response.status_code", value: { intValue: "200" } },
{ key: "cf-aig-request-id", value: { stringValue: "smoke-request" } },
{ key: "gateway", value: { stringValue: "smoke" } },
{ key: "env", value: { stringValue: "smoke" } },
{ key: "gen_ai.prompt_json", value: { stringValue: '{"token":"sk-live-smoke"}' } },
```

Add a `lokiRecordMatches(json)` predicate that parses returned Loki entries and returns true only when the record has canonical fields `provider: "smoke-provider"`, `input_tokens: 12`, `output_tokens: 7`, `total_tokens: 19`, `cost_usd: 0.0125`, contains `[REDACTED]`, and does not contain `sk-live-smoke`. Query Loki with all four fixed labels:

```js
'{gateway="smoke",env="smoke",model="smoke-model",status_code="200"}';
```

- [ ] **Step 4: Run the smoke-driver and local container E2E tests**

Run:

```bash
node --test tests/otel-smoke-retry.test.mjs
make otel-smoke
```

Expected: the mocked retry test passes, then Docker reports a successful smoke container after validating Prometheus, Loki, and Tempo.

- [ ] **Step 5: Create the commit only if a later user instruction explicitly requests a commit**

```bash
git add deploy/otel/scripts/synthetic-otlp-smoke.mjs tests/otel-smoke-retry.test.mjs
git commit -m "test(otel): Cloudflare属性のfan-outを検証"
```

## Task 5: Publish the Free Tier OTel Operations Guide

**Files:**

- Create: `docs/free-tier-ai-gateway-otel.md`
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `tests/deployment-contracts.test.mjs`

**Interfaces:**

- Consumes: Docker Compose files, the existing `graft-ai-telemetry-write` Grafana access policy, a Cloudflare managed Tunnel token, and the configured proxy Worker values.
- Produces: a repeatable operator procedure that does not require Logpush and does not put secrets into tracked files.
- Guarantees: operators configure exactly one AI Gateway OTel exporter, target the Tunnel endpoint, use `graft-ai-otel-observability`, and verify all three Grafana data sources.

- [ ] **Step 1: Add a failing documentation contract test**

In `tests/deployment-contracts.test.mjs`, load the new guide and assert the mandatory interface is documented.

```js
const freeTierOtelGuide = readFileSync(
  resolve(root, "docs/free-tier-ai-gateway-otel.md"),
  "utf8",
);

test("Free Tier OTel guide uses the Tunnel and does not require Logpush", () => {
  for (const text of [
    "https://<otel-public-hostname>/v1/traces",
    "Authorization: Bearer <OTEL_INGEST_TOKEN>",
    "OTEL_GRAFANA_CLOUD_LOGS_RETENTION",
    "graft-ai-otel-observability",
    "graft-ai-aig-overview",
  ]) {
    assert.match(
      freeTierOtelGuide,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(freeTierOtelGuide, /does not use Workers Logpush/);
});
```

- [ ] **Step 2: Run the documentation contract and confirm it fails**

Run:

```bash
node --test tests/deployment-contracts.test.mjs
```

Expected: FAIL because the guide does not exist.

- [ ] **Step 3: Write the operational guide with these exact sections**

Create `docs/free-tier-ai-gateway-otel.md` with the following concrete procedure:

1. State the target topology: `AI Gateway -> Cloudflare Tunnel -> Alloy -> Tempo/Loki/Prometheus`, and explicitly state that it does not use Workers Logpush.
2. List the required host tools: Docker Engine with Compose plugin and a Cloudflare managed Tunnel.
3. Explain that `deploy/otel/secrets/` and `deploy/otel/.env.grafana-cloud` are ignored by `.gitignore`; create the directory with mode `0700` and each secret file with mode `0600`.
4. Define the four secret files: `otel_ingest_token`, `otel_hmac_key`, `cloudflared_token`, and `grafana_admin_password` when self-hosted Grafana is also started. Require the ingest token and HMAC key to be different random values.
5. Define the seven non-file Cloud variables: `OTEL_TEMPO_URL`, `OTEL_TEMPO_AUTHORIZATION`, `OTEL_LOKI_URL`, `OTEL_LOKI_AUTHORIZATION`, `OTEL_PROMETHEUS_URL`, `OTEL_PROMETHEUS_AUTHORIZATION`, and `OTEL_GRAFANA_CLOUD_LOGS_RETENTION=14d` after confirming the Grafana Cloud Logs retention.
6. Configure a Cloudflare Tunnel public hostname whose service is `http://alloy:4318`; do not publish an Alloy host port.
7. Start only Alloy and cloudflared in Cloud mode using this command:

```bash
docker compose --env-file deploy/otel/.env.grafana-cloud \
  -f deploy/otel/docker-compose.yml \
  -f deploy/otel/docker-compose.grafana-cloud.yml \
  --profile tunnel up -d --build alloy cloudflared
```

8. In AI Gateway Settings, edit the existing exporter instead of adding a second one: set URL to `https://<otel-public-hostname>/v1/traces`, header to `Authorization: Bearer <OTEL_INGEST_TOKEN>`, and content type to `protobuf`.
9. Specify the validation queries: Tempo TraceQL `{ span.graft_ai.request_span = true }`, Loki `{gateway="main",env="prod"} | json`, and Prometheus `sum by (model, provider) (increase(ai_gateway_requests_total{gateway="main",env="prod"}[15m]))`.
10. State that `graft-ai-aig-overview` remains Logpush-specific and is expected to be empty in this mode; use `graft-ai-otel-observability` instead.
11. State the safe failure action: disable the exporter and inspect `docker compose logs alloy cloudflared`; do not restore the direct Grafana exporter because it bypasses redaction.

- [ ] **Step 4: Link the guide from both READMEs**

Add one concise link in the existing OTel sections of `README.md` and `README.ja.md`. The English README must say the guide is the Free Tier deployment path; the Japanese README must state that the OTel dashboard, not the Logpush dashboard, is the intended dashboard in this mode.

- [ ] **Step 5: Run documentation validation**

Run:

```bash
node --test tests/deployment-contracts.test.mjs
```

Expected: the guide contract passes and the existing deployment contracts remain green.

- [ ] **Step 6: Create the commit only if a later user instruction explicitly requests a commit**

```bash
git add docs/free-tier-ai-gateway-otel.md README.md README.ja.md tests/deployment-contracts.test.mjs
git commit -m "docs(otel): Free Tier導入手順を追加"
```

## Task 6: Activate the Production Route and Perform Manual QA

**Files:**

- No tracked source changes.
- Local untracked runtime files: `deploy/otel/secrets/*` and `deploy/otel/.env.grafana-cloud`.

**Interfaces:**

- Consumes: the completed code changes, existing Grafana Cloud datasource UIDs, a valid Grafana telemetry Access Policy token, an AI Gateway with an existing direct exporter, and normal proxy traffic.
- Produces: one redacted, three-backend telemetry route for the existing AI Gateway.
- Guarantees: the AI Gateway has exactly one active OTel exporter and it targets the Tunnel endpoint.

- [ ] **Step 1: Run all repository validation before touching remote settings**

Run:

```bash
make test
make typecheck
make fmt
make validate
make otel-validate
make otel-smoke
```

Expected: every command exits with status 0. Do not change Cloudflare or Grafana settings if any command fails.

- [ ] **Step 2: Provision untracked Alloy runtime files on the host**

Create the protected directory and files from secure environment variables without writing their values to the terminal.

```bash
umask 077
install -d -m 700 deploy/otel/secrets
printf '%s' "$OTEL_INGEST_TOKEN" > deploy/otel/secrets/otel_ingest_token
printf '%s' "$OTEL_RATE_LIMIT_HMAC_KEY" > deploy/otel/secrets/otel_hmac_key
printf '%s' "$CLOUDFLARED_TUNNEL_TOKEN" > deploy/otel/secrets/cloudflared_token
chmod 600 deploy/otel/secrets/otel_ingest_token deploy/otel/secrets/otel_hmac_key deploy/otel/secrets/cloudflared_token
```

Create `deploy/otel/.env.grafana-cloud` through the host secret manager or protected editor with the seven non-file variables named in Task 5. Do not add the file to Git.

- [ ] **Step 3: Start the protected Cloud-mode receiver and confirm the containers are healthy**

Run:

```bash
docker compose --env-file deploy/otel/.env.grafana-cloud \
  -f deploy/otel/docker-compose.yml \
  -f deploy/otel/docker-compose.grafana-cloud.yml \
  --profile tunnel up -d --build alloy cloudflared
docker compose --env-file deploy/otel/.env.grafana-cloud \
  -f deploy/otel/docker-compose.yml \
  -f deploy/otel/docker-compose.grafana-cloud.yml \
  --profile tunnel ps alloy cloudflared
```

Expected: both services show `running`; Alloy binds only to its Docker network and does not expose a host port.

- [ ] **Step 4: Switch the single AI Gateway exporter**

In Cloudflare Dashboard, open the target AI Gateway, open **Settings**, and edit the sole OTel exporter. Set:

```text
URL: https://<otel-public-hostname>/v1/traces
Header name: Authorization
Header value: Bearer <OTEL_INGEST_TOKEN>
Content type: protobuf
```

Save the setting, then confirm the former `https://otlp-gateway-.../otlp/v1/traces` direct exporter is no longer configured. Do not create a second exporter.

- [ ] **Step 5: Generate one controlled normal gateway request**

Use an existing low-cost provider credential and the deployed proxy Worker. The request path must omit the leading provider gateway prefix because `workers/src/proxy.ts` appends it to the AI Gateway URL.

```bash
curl --fail-with-body --show-error \
  "${PROXY_WORKER_URL}/openai/chat/completions" \
  -H "X-Proxy-Secret: ${PROXY_SECRET}" \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Reply only with OK."}],"max_tokens":1}'
```

Expected: the proxy returns a successful provider response. This request establishes an actual AI Gateway span rather than merely exercising the receiver with a synthetic span.

- [ ] **Step 6: Verify the visible Grafana surfaces**

Within 15 minutes, open `graft-ai-otel-observability` and confirm all of the following:

```text
Tempo TraceQL: { span.graft_ai.request_span = true }
Loki: {gateway="main",env="prod"} | json
Prometheus: sum by (model, provider) (increase(ai_gateway_requests_total{gateway="main",env="prod"}[15m]))
```

Expected: Tempo contains a selected request span; Loki contains a redacted request record with only `model`, `status_code`, `env`, and `gateway` stream labels; Prometheus reports a non-zero series whose `provider` is not `unknown`.

- [ ] **Step 7: Record the runtime outcome without exposing credentials**

Record only these non-secret facts in the change summary: Tunnel hostname configured, exporter content type, whether Tempo/Loki/Prometheus each returned a result, dashboard URL, and any disabled exporter. Do not include URLs containing credentials, Authorization values, token fragments, request bodies, or response bodies.

## Final Verification Checklist

- [ ] `workers/tests/proxy.test.ts` proves fixed `gateway` and `env` metadata injection.
- [ ] Alloy ingress and metrics tests prove `gen_ai.model.provider` produces a real provider label.
- [ ] Grafana Cloud Compose fails early without a confirmed retention value and passes with a non-secret `14d` test value.
- [ ] The local smoke test sends Cloudflare semantic-convention attributes and verifies Tempo, redacted Loki, and Prometheus output.
- [ ] The production guide is linked from both READMEs and does not suggest Logpush for the Free Tier route.
- [ ] The live AI Gateway exporter points only to the Tunnel endpoint, uses `protobuf`, and sends an Authorization bearer header.
- [ ] The `graft-ai-otel-observability` dashboard shows one real request in all three data sources; `graft-ai-aig-overview` is not used as a Free Tier success criterion.

## Plan Self-Review

- **Spec coverage:** Tasks 1 and 2 supply stable `env`, `gateway`, model, provider, token, cost, and status attributes; Task 3 enables the bounded-retention Loki branch; Task 4 proves all three fan-out targets and redaction; Tasks 5 and 6 cover Tunnel setup, AI Gateway settings, Grafana visibility, and safe shutdown.
- **Placeholder scan:** Every configuration value is either an exact environment-variable name, an exact fixed endpoint path, or an explicit Cloudflare/Grafana UI field. No secret value is represented as a deployable literal.
- **Type consistency:** `ProxyEnv`, `buildUpstreamInit(request, env)`, canonical `provider`, `OTEL_GRAFANA_CLOUD_LOGS_RETENTION`, `/v1/traces`, and the `graft-ai-otel-observability` UID use one spelling throughout the plan.

## Execution Handoff

Plan complete. Execute this plan inline with `superpowers:executing-plans`; do not use subagents for any task in this plan.
