# Design Specification: Cloudflare D1 Payload Store for AI Gateway OTel Telemetry

**Date**: 2026-09-04  
**Author**: Antigravity Assistant & y_ohi  
**Status**: Approved  

---

## 1. Context & Motivation

`graft-ai` operates a dedicated Cloudflare Worker (`graft-ai-aig-otel`) that receives OpenTelemetry traces exported from Cloudflare AI Gateway, persists incoming payloads to an intermediate object store, and reliably forwards them asynchronously via Cloudflare Queues to Grafana Cloud (Tempo, Loki, and Prometheus).

### 1.1 The Incident: KV Quota Exhaustion
Under the previous design, `OTEL_PAYLOAD_STORE=kv` was the default backend. Cloudflare Workers KV free tier imposes a strict limit of **1,000 writes/day**. During routine AI development with agentic tools (e.g. high-frequency LLM requests), the 1,000 write quota was depleted before noon (10:48 JST). Consequently, all subsequent trace ingestions failed with `503 Service Unavailable` (`{"error":"persistence_failed"}`), cutting off telemetry ingestion.

### 1.2 The Constraint: R2 Credit Card Requirement
Although `graft-ai` supports R2 (`OTEL_PAYLOAD_STORE=r2`), Cloudflare R2 requires a **registered credit card** even within its free tier (1,000,000 writes/month). To maintain the strict principle of zero-cost operation without requiring credit card registration, R2 cannot serve as the default zero-barrier storage backend.

### 1.3 The Solution: Cloudflare D1
Cloudflare D1 (Serverless SQLite) provides:
- **No credit card registration required** (fully available on Workers Free).
- **100,000 writes/day** (100× the capacity of Workers KV).
- **5,000,000 reads/day**.
- **5 GB storage allowance**.
- **Strong consistency** (eliminating KV's 60-second queue propagation delay).

---

## 2. Requirements & Goals

1. **Credit-Card-Free & Zero-Cost Operation**:
   - Deliver uninterrupted trace ingestion on Cloudflare's Free tier without registering payment methods.
2. **High Daily Write Capacity**:
   - Handle up to 100,000 payloads/day (~1.15 req/sec 24/7 continuous average load).
3. **Strong Consistency & Zero Propagation Delay**:
   - Queue pointers backed by D1 can be delivered immediately (`delaySeconds: 0`), unlike KV which requires 60 seconds (`KV_PROPAGATION_DELAY_SECONDS = 60`).
4. **Seamless Backward Compatibility**:
   - In-flight queue pointers from previous deployments backed by KV (`storageBackend: "kv"`) or legacy R2 (`schemaVersion: 1` or `storageBackend: "r2"`) must continue to be read and deleted cleanly via their respective store bindings.
5. **Deterministic Failsafe TTL Cleanup**:
   - In normal operation, payloads are deleted upon export via `deleteObject(pointer)`.
   - For orphaned records, a scheduled Cron Trigger (`0 4 * * *` UTC) purges expired records (`expires_at < unixepoch()`) without loading or adding latency to the trace ingress hot path.

---

## 3. Architecture & Data Model

### 3.1 D1 Database Schema
Table definition managed under [`workers/migrations/0001_create_otel_payloads.sql`](../../../workers/migrations/0001_create_otel_payloads.sql):

```sql
CREATE TABLE IF NOT EXISTS otel_payloads (
  object_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otel_payloads_expires_at ON otel_payloads(expires_at);
```

- `object_key`: Unique key identifier, e.g. `otel/ingress/<date>/<uuid>.json` or `otel/export/<backend>/<date>/<job_id>.json`.
- `sha256`: Hexadecimal SHA-256 digest of `data`.
- `content_type`: Mime type, strictly `"application/json"`.
- `kind`: Source stage, `"ingress"` or `"export"`.
- `data`: Binary BLOB containing the serialized payload.
- `created_at`: Epoch seconds timestamp when inserted.
- `expires_at`: Epoch seconds when record is eligible for failsafe deletion (`created_at + 7 days`).
- `idx_otel_payloads_expires_at`: B-tree index enabling efficient range deletion without table scans.

### 3.2 Contracts & Types Updates

- **[`workers/src/otel/contracts.ts`](../../../workers/src/otel/contracts.ts)**:
  ```ts
  export const PAYLOAD_STORE_BACKENDS = ["kv", "r2", "d1"] as const;
  export type PayloadStoreBackend = (typeof PAYLOAD_STORE_BACKENDS)[number];
  ```
- **[`workers/src/otel/types.ts`](../../../workers/src/otel/types.ts)**:
  ```ts
  export interface OtelEnv {
    // ...
    readonly OTEL_PAYLOAD_D1?: D1Database;
    // ...
  }
  ```
  `CurrentObjectPointer` already includes `storageBackend: PayloadStoreBackend`, which automatically admits `"d1"`.

### 3.3 `D1PayloadStore` Implementation

In [`workers/src/otel/storage.ts`](../../../workers/src/otel/storage.ts):

```ts
export class D1PayloadStore extends PayloadStoreBase {
  readonly backend = "d1" as const;

  constructor(private readonly db: D1Database) {
    super();
  }

  async putBytesObject(
    objectKey: string,
    bytes: Uint8Array,
    kind: "ingress" | "export",
  ): Promise<CurrentObjectPointer> {
    const sha256 = await sha256Hex(bytes);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + PAYLOAD_RETENTION_TTL_SECONDS;

    try {
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO otel_payloads
           (object_key, sha256, content_type, kind, data, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(objectKey, sha256, CONTENT_TYPE, kind, bytes, nowSeconds, expiresAt)
        .run();
    } catch (error) {
      throw classifyStoreFailure(error, "D1 payload write");
    }

    return currentPointer(objectKey, sha256, this.backend);
  }

  async readBytesObject(pointer: ObjectPointer): Promise<Uint8Array> {
    let row: { data: ArrayBuffer | Uint8Array; sha256: string; content_type: string } | null;
    try {
      row = await this.db
        .prepare(`SELECT data, sha256, content_type FROM otel_payloads WHERE object_key = ?`)
        .bind(pointer.objectKey)
        .first();
    } catch (error) {
      throw classifyStoreFailure(error, "D1 payload read");
    }

    if (!row) throw new PayloadStoreNotFoundError();
    if (row.content_type !== pointer.contentType) {
      throw new PayloadStoreIntegrityError("payload object content type mismatch");
    }
    if (row.sha256 !== pointer.sha256) {
      throw new PayloadStoreIntegrityError("payload object metadata checksum mismatch");
    }

    const bytes = new Uint8Array(row.data);
    const actualSha256 = await sha256Hex(bytes);
    if (actualSha256 !== pointer.sha256) {
      throw new PayloadStoreIntegrityError("payload object checksum mismatch");
    }
    return bytes;
  }

  async deleteObject(pointer: ObjectPointer): Promise<void> {
    try {
      await this.db
        .prepare(`DELETE FROM otel_payloads WHERE object_key = ?`)
        .bind(pointer.objectKey)
        .run();
    } catch (error) {
      throw classifyStoreFailure(error, "D1 payload delete");
    }
  }

  async deleteExpired(nowSeconds: number): Promise<number> {
    try {
      const result = await this.db
        .prepare(`DELETE FROM otel_payloads WHERE expires_at < ?`)
        .bind(nowSeconds)
        .run();
      return result.meta.changes ?? 0;
    } catch (error) {
      throw classifyStoreFailure(error, "D1 payload purge");
    }
  }
}
```

### 3.4 Storage Resolver & Delivery Delay Logic

- `resolvePayloadStoreBackend(value: string | undefined)`:
  - If unset or empty string, defaults to `"d1"`.
  - Validates input against `["kv", "r2", "d1"]`.
- `payloadStoreForBackend(env: OtelEnv, backend: PayloadStoreBackend)`:
  - When `backend === "d1"`, verifies `env.OTEL_PAYLOAD_D1` exists and returns `new D1PayloadStore(env.OTEL_PAYLOAD_D1)`.
- `queueDeliveryDelaySeconds(pointer: ObjectPointer)`:
  - Only returns `KV_PROPAGATION_DELAY_SECONDS` (60s) when `pointer.schemaVersion === 2 && pointer.storageBackend === "kv"`.
  - Returns `0` for `"d1"` and `"r2"`.

---

## 4. Ingress, Queue, and Failsafe Purge Lifecycle

```
[ Ingress Request ]
        │
        ▼
[ Rate Limit & Redaction ]
        │
        ▼
[ D1PayloadStore.putJsonObject ] ──► INSERT OR REPLACE into otel_payloads (expires_at = now + 7d)
        │
        ▼
[ Enqueue IngressPointer ] ──► delaySeconds = 0
        │
        ▼
[ Queue Batch Processing ] ──► Read via payloadStoreForPointer (validates SHA-256)
        │
        ▼
[ Export / Grafana Forwarding ] ──► Tempo / Loki / Prometheus
        │
        ▼
[ D1PayloadStore.deleteObject ] ──► DELETE FROM otel_payloads WHERE object_key = ?

[ Cron Trigger (0 4 * * *) ] ──► scheduled() handler ──► D1PayloadStore.deleteExpired(now)
```

### 4.1 Scheduled Handler
In [`workers/src/otel.ts`](../../../workers/src/otel.ts):
```ts
export default {
  async fetch(request: Request, env: OtelEnv, ctx: ExecutionContext): Promise<Response> {
    // ... existing ingress logic
  },
  async queue(batch: MessageBatch<QueuePointer>, env: OtelEnv): Promise<void> {
    // ... existing queue consumer logic
  },
  async scheduled(event: ScheduledEvent, env: OtelEnv, ctx: ExecutionContext): Promise<void> {
    if (env.OTEL_PAYLOAD_D1) {
      const store = new D1PayloadStore(env.OTEL_PAYLOAD_D1);
      const changes = await store.deleteExpired(Math.floor(Date.now() / 1000));
      console.log(`[D1 Purge] Removed ${changes} expired payload records`);
    }
  }
};
```

### 4.2 Error Classification
In `classifyStoreFailure(error: unknown, operation: string)`:
- Quota: match on `/quota|daily limit|rate limit|limit exceeded/i` $\rightarrow$ `PayloadStoreQuotaError`.
- Temporary / Locks: match on `/database is locked|busy|timeout|network/i` $\rightarrow$ `PayloadStoreTemporaryError`.
- Integrity: Checksum/schema mismatch $\rightarrow$ `PayloadStoreIntegrityError`.

---

## 5. Configuration & Infrastructure

### 5.1 Terraform Resources
In [`terraform/otel.tf`](../../../terraform/otel.tf):
```hcl
resource "cloudflare_d1_database" "otel_payloads" {
  account_id = var.cloudflare_account_id
  name       = var.otel_d1_database_name
}
```

In [`terraform/variables.tf`](../../../terraform/variables.tf):
```hcl
variable "otel_d1_database_name" {
  description = "Fixed name for the dedicated OTel D1 payload database"
  type        = string
  default     = "graft-ai-aig-otel-payloads-v1"

  validation {
    condition     = var.otel_d1_database_name == "graft-ai-aig-otel-payloads-v1"
    error_message = "otel_d1_database_name is fixed to graft-ai-aig-otel-payloads-v1."
  }
}
```

In [`terraform/outputs.tf`](../../../terraform/outputs.tf):
```hcl
output "otel_payload_d1_database_id" {
  description = "Cloudflare D1 database ID used by the dedicated OTel Worker payload store"
  value       = cloudflare_d1_database.otel_payloads.id
}
```

### 5.2 Wrangler Configuration & Renderer
In [`workers/wrangler.otel.jsonc`](../../../workers/wrangler.otel.jsonc):
- `vars.OTEL_PAYLOAD_STORE`: `"d1"`
- `triggers`: `{ "crons": ["0 4 * * *"] }`
- `d1_databases`:
  ```jsonc
  "d1_databases": [
    {
      "binding": "OTEL_PAYLOAD_D1",
      "database_name": "graft-ai-aig-otel-payloads-v1",
      "database_id": "__OTEL_PAYLOAD_D1_DATABASE_ID__"
    }
  ]
  ```
- Keep `OTEL_PAYLOAD_KV` binding intact to allow reading and deleting lingering KV pointers.

In [`scripts/render-otel-worker-config.mjs`](../../../scripts/render-otel-worker-config.mjs):
- Add `--d1-database-id` CLI option.
- Default `payloadStore` to `"d1"`.
- Replace `__OTEL_PAYLOAD_D1_DATABASE_ID__` with provided ID (or test sentinel).
- Validate UUID/hex database ID formatting.

In [`scripts/verify-otel-worker-config.mjs`](../../../scripts/verify-otel-worker-config.mjs):
- Validate D1 database binding presence and ID configuration.
- Validate crons trigger presence.

### 5.3 Makefile Updates
- `OTEL_PAYLOAD_STORE ?= d1`
- `otel-worker-infrastructure`: Include `-target=cloudflare_d1_database.otel_payloads`.
- `render-otel-worker-config`: Pass `--d1-database-id` using `OTEL_PAYLOAD_D1_DATABASE_ID`.
- `deploy-otel-worker`: Execute `cd workers && npx wrangler d1 migrations apply graft-ai-aig-otel-payloads-v1 --remote` prior to Worker deployment.

---

## 6. Testing & Verification Plan

1. **Storage Unit Tests** ([`workers/tests/otel/storage.test.ts`](../../../workers/tests/otel/storage.test.ts)):
   - Write, read, delete roundtrip on `D1PayloadStore`.
   - Content-type validation, checksum validation, and `PayloadStoreIntegrityError` throwing on corrupted bytes.
   - `PayloadStoreNotFoundError` throwing when querying non-existent keys.
   - `deleteExpired` removing expired items while retaining active ones.
   - `queueDeliveryDelaySeconds` returning 0 for `d1`.
   - Backward-compatibility test: successfully read and delete KV and R2 pointers when running with `OTEL_PAYLOAD_STORE=d1`.
2. **Worker Contract & Configuration Tests** ([`workers/tests/otel-worker-contracts.test.mjs`](../../../workers/tests/otel-worker-contracts.test.mjs) & [`tests/deployment-contracts.test.mjs`](../../../tests/deployment-contracts.test.mjs)):
   - Test rendering and validation with D1 default.
   - Test explicit KV and R2 options.
   - Verify cron triggers and scheduled exports.
3. **Verification Gates**:
   - `make fmt`
   - `make typecheck`
   - `make test`
   - `make validate`
