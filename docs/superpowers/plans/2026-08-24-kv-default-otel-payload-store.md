<!-- markdownlint-disable MD013 -->

# KV-Default OTel Payload Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dedicated OTel Worker persist redacted Queue payloads in Cloudflare Workers KV by default, while allowing an operator to select R2 with `OTEL_PAYLOAD_STORE=r2` without changing the Queue, ledger, checksum, retry, or DLQ contracts.

**Architecture:** Introduce a payload-store interface that writes to the backend selected for new payloads and reads/deletes from the backend recorded in each pointer. New pointers use schema version 2 and contain `storageBackend`; legacy schema-version-1 pointers are treated as R2 pointers. A generated Wrangler deployment config supplies the Terraform-created KV namespace ID and conditionally adds the R2 binding, so the normal KV deployment never contacts R2.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers KV, Cloudflare R2, Cloudflare Queues, SQLite-backed Durable Objects, Wrangler 4, Vitest with `@cloudflare/vitest-pool-workers`, Terraform Cloudflare provider 5, GitHub Actions.

## Global Constraints

- `OTEL_PAYLOAD_STORE` accepts only `kv` or `r2`; missing or blank values mean `kv`.
- New payload pointers use `schemaVersion: 2` and include `storageBackend: "kv" | "r2"`. A persisted schema-version-1 pointer has no backend field and must resolve to R2 so already-enqueued payloads remain readable.
- Keep the existing object-key format, SHA-256 verification, `application/json` content type, stable ingress/export IDs, 8 MiB ingress cap, 4,000,000-byte Grafana payload cap, Queue retry/DLQ behavior, and the four Loki labels.
- KV payload writes use a seven-day `expirationTtl`; R2 retains the existing seven-day Terraform lifecycle rule. Successful and expired records still explicitly delete their payloads.
- KV is eventually consistent. Every first delivery of a new KV-backed pointer must use a 60-second Queue delay; R2-backed pointers retain immediate delivery. Normal retry delays remain unchanged.
- The default deployment must bind KV only and must not create, bind, or require an enabled R2 subscription. R2 is opt-in through `OTEL_PAYLOAD_STORE=r2` and a rendered config containing both KV and R2 bindings.
- Do not store raw OTLP payloads, credentials, or authorization values in either store, templates, source-controlled config, Terraform variables, logs, or tests.
- Do not add a high-cardinality Loki label. Store backend identity is pointer metadata, not a Loki label.
- Do not commit generated Wrangler configs, Terraform state, namespace IDs, or secrets. Commit only when the user explicitly requests it.

---

## File Structure

<!-- prettier-ignore -->
| File | Change | Responsibility |
| --- | --- | --- |
| `workers/src/otel/contracts.ts` | Modify | Add backend names, KV propagation delay, and backend-neutral payload retention constants. |
| `workers/src/otel/types.ts` | Modify | Model v1/v2 pointers, payload-store backend selection, optional KV/R2 bindings, and store interface. |
| `workers/src/otel/storage.ts` | Modify | Implement backend selection plus equivalent KV and R2 put/read/delete/checksum behavior. |
| `workers/src/otel/ingress.ts` | Modify | Persist ingress through the selected store and delay KV Queue delivery. |
| `workers/src/otel/exporter.ts` | Modify | Persist export payloads through the selected store and retain backend identity in pointers. |
| `workers/src/otel/queue.ts` | Modify | Read/delete through the pointer backend and preserve existing retry/DLQ behavior. |
| `workers/src/otel/ledger.ts` | Modify | Requeue ready pointers with their backend-specific initial delay and delete expired payloads through the store. |
| `workers/tests/otel/{storage,ingress,exporter,queue,pipeline,trace-aggregate,metrics-aggregate}.test.ts` | Modify | Cover KV-default and R2-selected persistence without directly assuming R2 APIs. |
| `workers/wrangler.otel.jsonc` | Modify | Become the source-controlled KV-default deployment template. |
| `scripts/render-otel-worker-config.mjs` | Create | Render a deployable config with a real KV namespace ID and optional R2 binding. |
| `workers/vitest.otel.config.ts` | Modify | Test the rendered KV configuration. |
| `workers/vitest.otel.r2.config.ts` | Create | Test the rendered dual-binding R2 configuration locally. |
| `workers/package.json` | Modify | Render test configs before Worker validation and run both storage-backend suites. |
| `terraform/{otel.tf,variables.tf,outputs.tf,terraform.tfvars.example}` | Modify | Provision and output the KV namespace while leaving R2 resources opt-in at deployment time. |
| `.github/workflows/{ci,deploy}.yml` | Modify | Test both local backends; default production apply/deploy to KV; opt into R2 only when selected. |
| `scripts/verify-otel-worker-config.mjs` | Modify | Validate the template and rendered KV/R2 binding contracts. |
| `workers/tests/otel-worker-contracts.test.mjs`, `tests/deployment-contracts.test.mjs` | Modify | Lock down selector, renderer, Terraform target, and workflow behavior. |
| `README.md`, `README.ja.md`, `SPEC.md`, `SPEC.ja.md`, `docs/cloudflare-worker-ai-gateway-otel.md` | Modify | Document KV-default operation, limits, R2 opt-in, and safe migration/rollback. |

## Task 1: Add a Versioned Payload-Store Contract

**Files:**

- Modify: `workers/src/otel/contracts.ts`
- Modify: `workers/src/otel/types.ts`
- Modify: `workers/src/otel/storage.ts`
- Modify: `workers/tests/otel/storage.test.ts`

**Interfaces:**

- Produces `type PayloadStoreBackend = "kv" | "r2"` and `resolvePayloadStoreBackend(value: string | undefined): PayloadStoreBackend`.
- Produces `payloadStoreForWrite(env: OtelEnv): PayloadStore`, `payloadStoreForPointer(env: OtelEnv, pointer: ObjectPointer): PayloadStore`, and `queueDeliveryDelaySeconds(pointer: ObjectPointer): number`.
- Produces a schema-version-2 pointer with `storageBackend`; schema-version-1 pointers remain valid only as legacy R2 pointers.
- Consumes `OtelEnv.OTEL_PAYLOAD_KV`, optional `OtelEnv.OTEL_OBJECTS`, and `OtelEnv.OTEL_PAYLOAD_STORE`.

- [ ] **Step 1: Write the failing payload-store tests**

Replace the R2-only storage assertion with backend-parameterized cases. The test must exercise the actual rendered KV and R2 Worker bindings, not a hand-written fake:

<!-- prettier-ignore -->
```ts
describe.each(["kv", "r2"] as const)("%s payload store", (backend) => {
  it("writes JSON with a checksum and records its backend", async () => {
    const store = payloadStoreForWrite(envFor(backend));
    const pointer = await store.putJsonObject(`otel/test/${crypto.randomUUID()}.json`, {
      safe: "[REDACTED]",
    });

    expect(pointer.schemaVersion).toBe(2);
    expect(pointer.storageBackend).toBe(backend);
    await expect(store.readJsonObject(pointer)).resolves.toEqual({ safe: "[REDACTED]" });
  });
});

it("defaults an unset selector to KV and rejects an unsupported selector", () => {
  expect(resolvePayloadStoreBackend(undefined)).toBe("kv");
  expect(resolvePayloadStoreBackend(" ")).toBe("kv");
  expect(() => resolvePayloadStoreBackend("d1")).toThrow(/OTEL_PAYLOAD_STORE/);
});

it("uses R2 for a legacy pointer even when new payloads use KV", async () => {
  const legacyPointer = {
    schemaVersion: 1,
    id: "legacy",
    objectKey: "otel/test/legacy.json",
    sha256,
    contentType: "application/json",
    createdAtMs: 1,
  } as const;
  await expect(
    payloadStoreForPointer(r2CapableEnv, legacyPointer).readBytesObject(legacyPointer),
  ).resolves.toEqual(bytes);
});
```

Add corruption cases for both stores: altered bytes, altered SHA metadata, unexpected content type, missing value, and idempotent delete. Assert generic messages such as `payload object checksum mismatch`; do not retain R2-only error text for a backend-neutral API.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/storage.test.ts
```

Expected: FAIL because no KV selector, v2 pointer shape, or payload-store factory exists.

- [ ] **Step 3: Define backend-neutral types and constants**

In `contracts.ts`, replace `R2_RETENTION_FAILSAFE_MS` with the backend-neutral name and add the KV consistency delay:

<!-- prettier-ignore -->
```ts
export const PAYLOAD_RETENTION_FAILSAFE_MS = 7 * 24 * 60 * 60 * 1_000;
export const PAYLOAD_RETENTION_TTL_SECONDS = PAYLOAD_RETENTION_FAILSAFE_MS / 1_000;
export const KV_PROPAGATION_DELAY_SECONDS = 60;
export const PAYLOAD_STORE_BACKENDS = ["kv", "r2"] as const;
export type PayloadStoreBackend = (typeof PAYLOAD_STORE_BACKENDS)[number];
```

In `types.ts`, make bindings optional because the KV-only config intentionally omits R2, and make old persisted pointers readable:

<!-- prettier-ignore -->
```ts
export type ObjectPointerBase = Readonly<{
  id: string;
  objectKey: string;
  sha256: string;
  contentType: "application/json";
  createdAtMs: number;
}>;

export type LegacyObjectPointer = ObjectPointerBase & Readonly<{ schemaVersion: 1 }>;
export type CurrentObjectPointer = ObjectPointerBase &
  Readonly<{ schemaVersion: 2; storageBackend: PayloadStoreBackend }>;

export type ObjectPointer = LegacyObjectPointer | CurrentObjectPointer;

export interface OtelEnv {
  readonly OTEL_PAYLOAD_STORE?: string;
  readonly OTEL_PAYLOAD_KV?: KVNamespace;
  readonly OTEL_OBJECTS?: R2Bucket;
  // Keep the existing Queue, Durable Object, secret, and Grafana fields unchanged.
}
```

Define `PayloadStore` with `putJsonObject`, `putBytesObject`, `readJsonObject`, `readBytesObject`, and `deleteObject`. Each method receives/returns the existing pointer and byte types; no caller may receive a raw `KVNamespace` or `R2Bucket`.

- [ ] **Step 4: Implement the two stores and pointer-based selection**

Refactor `storage.ts` so R2 preserves its current metadata behavior and KV stores the equivalent metadata in `KVNamespace.put()`:

<!-- prettier-ignore -->
```ts
type PayloadMetadata = Readonly<{
  schemaVersion: "1";
  sha256: string;
  contentType: "application/json";
  kind: "ingress" | "export";
}>;

await env.OTEL_PAYLOAD_KV.put(objectKey, bytes, {
  expirationTtl: PAYLOAD_RETENTION_TTL_SECONDS,
  metadata,
});

const stored = await env.OTEL_PAYLOAD_KV.getWithMetadata<PayloadMetadata>(
  pointer.objectKey,
  { type: "arrayBuffer" },
);
```

Validate value existence, `contentType`, stored metadata SHA-256, and recomputed byte SHA-256 before returning data. `payloadStoreForWrite()` resolves `env.OTEL_PAYLOAD_STORE`; `payloadStoreForPointer()` uses `pointer.storageBackend` for v2 and `"r2"` for v1. Both factories must throw a clear configuration error if their required binding is absent. `queueDeliveryDelaySeconds()` returns `60` only for KV pointers.

- [ ] **Step 5: Run both backend storage suites**

Run:

<!-- prettier-ignore -->
```bash
cd workers && npm run test:otel -- tests/otel/storage.test.ts
cd workers && npm run test:otel:r2 -- tests/otel/storage.test.ts
cd workers && npm run typecheck:otel
```

Expected: both suites pass; the first uses KV as the default and the second exercises the R2 implementation.

- [ ] **Step 6: Commit only if explicitly requested**

Stage only Task 1 files and use a Conventional Commit such as:

```text
feat(otel): KV/R2ペイロードストアを抽象化
```

## Task 2: Route All Persistence, Requeue, and Cleanup Through the Store

**Files:**

- Modify: `workers/src/otel/ingress.ts`
- Modify: `workers/src/otel/exporter.ts`
- Modify: `workers/src/otel/queue.ts`
- Modify: `workers/src/otel/ledger.ts`
- Modify: `workers/src/otel/trace-aggregate.ts`
- Modify: `workers/src/otel/metrics-aggregate.ts`
- Modify: `workers/tests/otel/ingress.test.ts`
- Modify: `workers/tests/otel/exporter.test.ts`
- Modify: `workers/tests/otel/queue.test.ts`
- Modify: `workers/tests/otel/pipeline.test.ts`
- Modify: `workers/tests/otel/trace-aggregate.test.ts`
- Modify: `workers/tests/otel/metrics-aggregate.test.ts`
- Modify: `workers/tests/otel/ledger.test.ts`

**Interfaces:**

- Consumes `PayloadStore` and `queueDeliveryDelaySeconds()` from Task 1.
- Produces schema-version-2 `IngressPointer` and `ExportPointer` records that preserve their write backend through Queue, Durable Object ledger, retry, DLQ, and retention cleanup.
- Guarantees that all newly-created KV pointers are first delivered after 60 seconds while R2 pointers are immediately delivered; normal retry delays of 1/2 seconds and `Retry-After` handling remain unchanged.

- [ ] **Step 1: Add failing end-to-end persistence tests**

Update tests to inspect payloads through `payloadStoreForPointer()` instead of `env.OTEL_OBJECTS.list/get`. Add these exact assertions:

<!-- prettier-ignore -->
```ts
it("uses KV and delays the first ingress delivery when the selector is unset", async () => {
  const response = await handleIngress(validRequest, { ...otelEnv, OTEL_PAYLOAD_STORE: undefined });
  expect(response.status).toBe(202);
  expect(lastIngressPointer.storageBackend).toBe("kv");
  expect(queueSendOptions).toEqual({ delaySeconds: 60 });
});

it("keeps R2-backed queued data readable after the write selector changes to KV", async () => {
  const pointer = await writeR2ExportPointer();
  await expect(
    exportPointer(pointer, { ...r2CapableEnv, OTEL_PAYLOAD_STORE: "kv" }),
  ).resolves.toMatchObject({ kind: "success" });
});

it("deletes a completed pointer from the backend stored in the pointer", async () => {
  const pointer = await writeExportPointer("r2");
  await consumeSuccessfulExport(pointer, { ...r2CapableEnv, OTEL_PAYLOAD_STORE: "kv" });
  await expect(
    payloadStoreForPointer(r2CapableEnv, pointer).readBytesObject(pointer),
  ).rejects.toThrow(/missing/);
});
```

Also retain the existing duplicate, collision, ready-reservation replay, claim, retry, terminal-DLQ, and expired-retention cases for both stores. Add a direct ledger retention test that verifies an expired v2 KV pointer is deleted and an expired legacy v1 pointer selects R2.

- [ ] **Step 2: Run the integration tests and confirm they fail**

Run:

<!-- prettier-ignore -->
```bash
cd workers && npx vitest run --config vitest.otel.config.ts tests/otel/ingress.test.ts tests/otel/exporter.test.ts tests/otel/queue.test.ts tests/otel/pipeline.test.ts
```

Expected: FAIL because producers and consumers still call `env.OTEL_OBJECTS` directly and do not record a storage backend or Queue delay.

- [ ] **Step 3: Replace every direct R2 call on the live path**

Make the following substitutions, preserving existing ledger transitions and error responses:

<!-- prettier-ignore -->
```ts
// ingress.ts: write new data and send it only after KV propagation time.
const store = payloadStoreForWrite(env);
const object = await store.putJsonObject(objectKey, envelope);
const pointer: IngressPointer = { ...object, kind: "ingress", ingressId };
await env.OTEL_INGRESS_QUEUE.send(pointer, {
  delaySeconds: queueDeliveryDelaySeconds(pointer),
});

// exporter.ts: write according to the configured backend.
const store = payloadStoreForWrite(env);
await store.putBytesObject(pointer.objectKey, bytes, "export");

// queue.ts: use the pointer, never the current write selector, for reads/deletes.
const store = payloadStoreForPointer(env, durablePointer);
const envelope = await store.readJsonObject<OtelIngressEnvelope>(durablePointer);
await store.deleteObject(durablePointer);
```

Apply the same send options to every first-send/re-send path: fresh ingress, duplicate ready ingress, fresh export, duplicate ready export, and ledger alarm recovery. Apply `payloadStoreForPointer(...).deleteObject()` to successful ingress completion, successful export completion, ready-transition rollback, and the ledger retention failsafe. Rename the internal retention constant and operational sample from R2-specific terminology to `payload` terminology, updating its tests in the same change.

- [ ] **Step 4: Preserve retry and DLQ semantics**

Do not change `consumeExport()` classification: 2xx acknowledges, terminal failures and exhausted retries reach the existing DLQ, and retryable responses use 1/2 seconds or the larger `Retry-After`. A missing or temporarily unavailable payload store value must throw, release the export claim, and use the existing Queue retry path; it must not be acknowledged or treated as a successful empty export.

- [ ] **Step 5: Run both complete OTel Worker suites**

Run:

<!-- prettier-ignore -->
```bash
cd workers && npm run test:otel
cd workers && npm run test:otel:r2
cd workers && npm run typecheck:otel
```

Expected: the KV suite proves default persistence and 60-second initial delivery options; the R2 suite proves the prior storage path and legacy-pointer compatibility.

- [ ] **Step 6: Commit only if explicitly requested**

Stage only Task 2 files and use a Conventional Commit such as:

<!-- prettier-ignore -->
```text
feat(otel): ペイロード保存先をポインタで固定
```

## Task 3: Render KV-Default and R2-Opt-In Deployment Configurations

**Files:**

- Modify: `workers/wrangler.otel.jsonc`
- Create: `scripts/render-otel-worker-config.mjs`
- Modify: `workers/vitest.otel.config.ts`
- Create: `workers/vitest.otel.r2.config.ts`
- Modify: `workers/package.json`
- Modify: `scripts/verify-otel-worker-config.mjs`
- Modify: `workers/tests/otel-worker-contracts.test.mjs`
- Modify: `terraform/otel.tf`
- Modify: `terraform/variables.tf`
- Modify: `terraform/outputs.tf`
- Modify: `terraform/terraform.tfvars.example`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `Makefile`
- Modify: `tests/deployment-contracts.test.mjs`

**Interfaces:**

- Produces `renderOtelWorkerConfig({ payloadStore, kvNamespaceId, includeR2Binding }): object` and a CLI that writes a generated config.
- Consumes the Terraform output `otel_payload_kv_namespace_id` and non-secret GitHub variable `OTEL_PAYLOAD_STORE`.
- Produces a KV-only generated config for `kv`; produces a dual-binding config for `r2` or explicit rollback draining.

- [ ] **Step 1: Write failing config-renderer and deployment-contract tests**

Extend `workers/tests/otel-worker-contracts.test.mjs` to import the renderer as a pure function. Use a fixed test-only 32-character namespace ID and assert both modes:

<!-- prettier-ignore -->
```js
const kv = renderOtelWorkerConfig(template, {
  payloadStore: "kv",
  kvNamespaceId: "00000000000000000000000000000000",
  includeR2Binding: false,
});
assert.equal(kv.vars.OTEL_PAYLOAD_STORE, "kv");
assert.deepEqual(kv.kv_namespaces, [{
  binding: "OTEL_PAYLOAD_KV",
  id: "00000000000000000000000000000000",
}]);
assert.equal(kv.r2_buckets, undefined);

const r2 = renderOtelWorkerConfig(template, {
  payloadStore: "r2",
  kvNamespaceId: "00000000000000000000000000000000",
  includeR2Binding: true,
});
assert.equal(r2.vars.OTEL_PAYLOAD_STORE, "r2");
assert.deepEqual(r2.r2_buckets, [
  { binding: "OTEL_OBJECTS", bucket_name: "graft-ai-aig-otel-v1" },
]);
```

Add negative cases for an invalid selector, an invalid namespace ID, a missing namespace ID, and a template that accidentally includes an R2 binding. In `tests/deployment-contracts.test.mjs`, assert that the default Terraform apply targets `cloudflare_workers_kv_namespace.otel_payloads` and does not target either R2 resource, while the `r2` branch targets both R2 resources.

- [ ] **Step 2: Run the new contract tests and confirm they fail**

Run:

<!-- prettier-ignore -->
```bash
node --test workers/tests/otel-worker-contracts.test.mjs
node --test tests/deployment-contracts.test.mjs
```

Expected: FAIL because no renderer, KV binding, KV namespace output, or selector-aware workflow exists.

- [ ] **Step 3: Make the tracked Wrangler config a safe KV-default template**

Modify `workers/wrangler.otel.jsonc` as a template, not a directly deployable production config:

<!-- prettier-ignore -->
```jsonc
"vars": {
  "GATEWAY_NAME": "main",
  "ENV_LABEL": "prod",
  "OTEL_PAYLOAD_STORE": "kv",
  "OTEL_SAMPLING_RATE": "1",
  "OTEL_GRAFANA_CLOUD_LOGS_RETENTION": "14d"
},
"kv_namespaces": [
  {
    "binding": "OTEL_PAYLOAD_KV",
    "id": "__OTEL_PAYLOAD_KV_NAMESPACE_ID__"
  }
]
```

Remove `r2_buckets` from this template. Retain all existing Queue, consumer, Durable Object, `workers_dev`, and observability settings unchanged.

Create `scripts/render-otel-worker-config.mjs` with a pure exported renderer plus a CLI. The CLI must require `--kv-namespace-id`, accept `--payload-store` defaulting to `kv`, accept `--include-r2-binding` for a KV rollback that must still consume old R2 pointers, and require `--output`. It must reject anything except 32 lowercase/uppercase hexadecimal characters for the namespace ID, replace the template sentinel, set `vars.OTEL_PAYLOAD_STORE`, and add the fixed R2 binding only when requested. Write JSON to the requested output path; never overwrite the source template.

- [ ] **Step 4: Create deterministic test and validation configs**

Set `workers/vitest.otel.config.ts` to read `.wrangler/otel.kv.test.jsonc` and create `workers/vitest.otel.r2.config.ts` for `.wrangler/otel.r2.test.jsonc`.

Add these scripts to `workers/package.json`:

<!-- prettier-ignore -->
```json
"render:otel:kv-test": "node ../scripts/render-otel-worker-config.mjs --payload-store kv --kv-namespace-id 00000000000000000000000000000000 --output .wrangler/otel.kv.test.jsonc",
"render:otel:r2-test": "node ../scripts/render-otel-worker-config.mjs --payload-store r2 --include-r2-binding --kv-namespace-id 00000000000000000000000000000000 --output .wrangler/otel.r2.test.jsonc",
"test:otel": "npm run render:otel:kv-test && vitest run --config vitest.otel.config.ts",
"test:otel:r2": "npm run render:otel:r2-test && vitest run --config vitest.otel.r2.config.ts",
"validate:otel": "npm run render:otel:kv-test && wrangler deploy --dry-run --config .wrangler/otel.kv.test.jsonc"
```

Update the config verifier so it validates the template's KV default/sentinel and validates renderer outputs in both modes. It must reject a production-looking KV mode that contains R2 and must require both bindings when R2 is selected.

- [ ] **Step 5: Provision KV through Terraform without making R2 a default dependency**

Add this resource to `terraform/otel.tf`; keep the existing Queue/DLQ and R2 resource declarations so an explicit R2 deployment remains managed by Terraform:

<!-- prettier-ignore -->
```hcl
resource "cloudflare_workers_kv_namespace" "otel_payloads" {
  account_id = var.cloudflare_account_id
  title      = var.otel_payload_kv_namespace_title
}
```

Add fixed-name variable validation in `terraform/variables.tf`:

<!-- prettier-ignore -->
```hcl
variable "otel_payload_kv_namespace_title" {
  description = "Fixed Workers KV namespace title for dedicated OTel payloads"
  type        = string
  default     = "graft-ai-aig-otel-payloads-v1"

  validation {
    condition     = var.otel_payload_kv_namespace_title == "graft-ai-aig-otel-payloads-v1"
    error_message = "otel_payload_kv_namespace_title is fixed to graft-ai-aig-otel-payloads-v1 to match the OTel Wrangler renderer."
  }
}
```

Expose `otel_payload_kv_namespace_id = cloudflare_workers_kv_namespace.otel_payloads.id`. Update the API-token description to require Queues and Workers KV write permissions by default, and R2 Storage Write only for an R2-selected deployment. Update the example variable comments to document the fixed KV namespace title and optional R2 bucket.

- [ ] **Step 6: Make CI and production deployment selector-aware**

In CI, run both `npm run test:otel` and `npm run test:otel:r2`; keep `make otel-worker-validate` as the KV-default dry-run.

In `.github/workflows/deploy.yml`, set a non-secret environment value once:

<!-- prettier-ignore -->
```yaml
OTEL_PAYLOAD_STORE: ${{ vars.OTEL_PAYLOAD_STORE || 'kv' }}
```

Validate it with a `case` statement. In the infrastructure apply step, always target Queue, DLQ, and `cloudflare_workers_kv_namespace.otel_payloads`; append the R2 bucket and lifecycle targets only for `r2`.

Before OTel secret synchronization, initialize Terraform, read `otel_payload_kv_namespace_id`, and render `workers/.wrangler/otel.generated.jsonc`. Pass `--payload-store "$OTEL_PAYLOAD_STORE"`; pass `--include-r2-binding` when the selector is `r2`. Use the generated config for every `wrangler secret put` and for the existing Wrangler deploy action command. Do not put the namespace ID into GitHub secrets because it is a Terraform output and not sensitive.

Update `Makefile` so `deploy-otel-worker` requires `OTEL_PAYLOAD_KV_NAMESPACE_ID`, defaults `OTEL_PAYLOAD_STORE` to `kv`, renders `.wrangler/otel.generated.jsonc`, and deploys that file. Document the equivalent manual R2 command with `OTEL_PAYLOAD_STORE=r2` and `--include-r2-binding`.

- [ ] **Step 7: Verify generated configs and infrastructure statically**

Run:

<!-- prettier-ignore -->
```bash
node --test workers/tests/otel-worker-contracts.test.mjs
node scripts/verify-otel-worker-config.mjs
cd workers && npm run validate:otel
terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false
terraform -chdir=terraform validate
node --test tests/deployment-contracts.test.mjs
```

Expected: KV is the only default storage binding; rendered R2 config contains both bindings; Terraform validates the KV namespace and existing optional R2 resources; no production config contains a real namespace ID.

- [ ] **Step 8: Commit only if explicitly requested**

Stage only Task 3 files and use a Conventional Commit such as:

```text
feat(otel): KV既定のデプロイ設定を追加
```

## Task 4: Update Operations Documentation and Verify the User-Facing Deployment Path

**Files:**

- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `SPEC.md`
- Modify: `SPEC.ja.md`
- Modify: `docs/cloudflare-worker-ai-gateway-otel.md`

**Interfaces:**

- Documents `OTEL_PAYLOAD_STORE=kv|r2`, with KV as the default.
- Documents `OTEL_PAYLOAD_KV` and optional `OTEL_OBJECTS` bindings without exposing actual namespace IDs or credentials.
- Documents the R2 opt-in and R2-to-KV rollback/drain procedure.

- [ ] **Step 1: Write documentation assertions before changing prose**

Extend the existing deployment-contract test to require both language README files and the OTel runbook to contain these stable operational facts:

<!-- prettier-ignore -->
```js
assert.match(readme, /OTEL_PAYLOAD_STORE/);
assert.match(readme, /default.*KV|KV.*default/i);
assert.match(runbook, /60[- ]second/i);
assert.match(runbook, /schema.?version.?1.*R2/i);
assert.match(runbook, /1,000.*writes.*day/i);
```

Use Japanese equivalents in assertions for `README.ja.md` and `SPEC.ja.md`. The test must also reject a statement that R2 is required for the default OTel deployment.

- [ ] **Step 2: Run documentation contracts and confirm they fail**

Run:

<!-- prettier-ignore -->
```bash
node --test tests/deployment-contracts.test.mjs
```

Expected: FAIL because the current docs describe R2 as the only payload store.

- [ ] **Step 3: Update the English and Japanese architecture descriptions**

In both README files and both specifications, replace R2-only wording with the exact contract:

- KV is the default payload store and has a 1 GB storage allowance, 1,000 writes/day, and 100,000 reads/day on Workers Free; reaching a free limit fails operations rather than enabling paid overage.
- The current 4 MB export payload cap fits below KV's 25 MiB value limit.
- KV's eventual consistency requires the 60-second first Queue delivery delay.
- R2 is optional, selected with `OTEL_PAYLOAD_STORE=r2`, and needs an enabled R2 subscription plus R2 write permission.
- Queue pointers contain no raw payload and include SHA-256 plus persistent backend identity.

Do not claim that the KV free limit guarantees delivery under arbitrary traffic. State that operators must monitor write volume and choose R2 explicitly if the workload exceeds KV's availability limits.

- [ ] **Step 4: Update the OTel Worker runbook with concrete deployment and rollback flows**

Add these three operations to `docs/cloudflare-worker-ai-gateway-otel.md`:

1. **Initial KV deployment:** apply Queue/DLQ/KV resources, obtain the Terraform namespace output in CI, render the KV-only config, deploy, then run the synthetic OTLP smoke test.
2. **R2 opt-in:** enable R2, set the non-secret repository variable `OTEL_PAYLOAD_STORE` to `r2`, apply the R2 targets, render the dual-binding config, deploy, and verify R2-selected storage with the smoke test.
3. **R2-to-KV rollback:** set `OTEL_PAYLOAD_STORE` to `kv`, render with `--include-r2-binding` so schema-v1 and v2 R2 pointers can drain, wait until source queues/DLQs are empty and the seven-day payload retention window has elapsed, then return to the KV-only generated config. Do not delete the R2 bucket as part of a normal rollback.

- [ ] **Step 5: Run all repository checks and manually exercise the deployment surface**

Run:

<!-- prettier-ignore -->
```bash
make otel-worker-test
make otel-worker-validate
make typecheck
make test
```

For a deployment-capable environment, set the documented non-secret selector and run the real surface:

<!-- prettier-ignore -->
```bash
OTEL_PAYLOAD_STORE=kv \
  OTEL_PAYLOAD_KV_NAMESPACE_ID="$(terraform -chdir=terraform output -raw otel_payload_kv_namespace_id)" \
  make deploy-otel-worker
make otel-worker-smoke
```

Expected: the deployed Worker accepts the smoke request, stores only redacted payload data, and completes the Queue-to-Grafana path using KV. Run the equivalent R2 smoke path only after R2 has been intentionally enabled.

- [ ] **Step 6: Commit only if explicitly requested**

Stage only Task 4 files and use a Conventional Commit such as:

<!-- prettier-ignore -->
```text
docs(otel): KV既定の保存先運用を文書化
```

## Plan Self-Review

- **Spec coverage:** Tasks 1 and 2 implement the selector, pointer persistence, KV consistency delay, checksum validation, legacy R2 reads, and unchanged retry/DLQ behavior. Task 3 implements binding provisioning and deployment selection. Task 4 covers operation and manual verification.
- **No-placeholder check:** Every new public type, configuration key, generated-file path, Terraform resource, deployment target, test command, and migration behavior is named above.
- **Type consistency:** New writes produce `schemaVersion: 2` with `storageBackend`; all reads/deletes select by pointer; only schema-version-1 pointers default to R2. `OTEL_PAYLOAD_STORE` determines writes, never reinterpretation of persisted pointers.
