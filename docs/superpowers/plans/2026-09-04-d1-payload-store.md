# Cloudflare D1 Payload Store Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `graft-ai-aig-otel` payload storage from Workers KV (1,000 writes/day quota limit) to Cloudflare D1 (100,000 row writes/day free limit, effective 16,600–50,000 requests/day, zero credit card requirement), with strong consistency (0s propagation delay), daily Cron Trigger purge for orphaned payloads, and backward compatibility for in-flight KV/R2 pointers.

**Architecture:** Implement `D1PayloadStore` extending `PayloadStoreBase` in `workers/src/otel/storage.ts` using SQLite prepared statements over Cloudflare D1 binding `OTEL_PAYLOAD_D1`. Add a Worker `scheduled` Cron Trigger (`0 4 * * *` UTC) in `workers/src/otel.ts` to purge expired records. Update config rendering, verification scripts, Terraform infrastructure (`cloudflare_d1_database`), Makefile targets, and documentation.

**Tech Stack:** TypeScript (strict mode), Cloudflare Workers (D1, Queues, KV, Durable Objects), Vitest (`@cloudflare/vitest-pool-workers`), Terraform (Cloudflare provider v5), Node.js.

## Global Constraints

- Tech stack: TypeScript with strict settings (`workers/tsconfig.json`); use npm inside `workers/`.
- Universal data contract: Loki labels are strictly limited to `model`, `status_code`, `env`, `gateway` on every path that writes to Loki; never add high-cardinality labels.
- Secrets hygiene: Never hardcode or commit secrets, tokens, or credentials.
- Verification gates: `make test`, `make typecheck`, `make fmt`, and `make validate` must pass before completion.
- Backward compatibility: In-flight Queue pointers with `storageBackend: "kv"` or `r2` must continue to be read and deleted without disruption.

---

### Task 1: D1 Migration SQL, Contracts, and Type Definitions

**Files:**
- Create: `workers/migrations/0001_create_otel_payloads.sql`
- Modify: `workers/src/otel/contracts.ts:20-25`
- Modify: `workers/src/otel/types.ts:182-200`
- Test: `workers/tests/otel-worker-contracts.test.mjs`

**Interfaces:**
- Consumes: None
- Produces:
  - `PAYLOAD_STORE_BACKENDS = ["kv", "r2", "d1"] as const`
  - `PayloadStoreBackend = "kv" | "r2" | "d1"`
  - `OtelEnv.OTEL_PAYLOAD_D1?: D1Database`
  - Table `otel_payloads` schema in migration SQL

- [ ] **Step 1: Create the D1 migration SQL file**

Create `workers/migrations/0001_create_otel_payloads.sql`:

```sql
-- Migration: Create otel_payloads table and expires_at index
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

- [ ] **Step 2: Update contracts in `workers/src/otel/contracts.ts`**

In `workers/src/otel/contracts.ts`:
Change line 22 from:
```ts
export const PAYLOAD_STORE_BACKENDS = ["kv", "r2"] as const;
```
to:
```ts
export const PAYLOAD_STORE_BACKENDS = ["kv", "r2", "d1"] as const;
```

- [ ] **Step 3: Update `OtelEnv` interface in `workers/src/otel/types.ts`**

In `workers/src/otel/types.ts`:
Add `OTEL_PAYLOAD_D1?: D1Database;` to `OtelEnv`:
```ts
export interface OtelEnv {
  readonly OTEL_INGRESS_QUEUE: Queue<IngressPointer>;
  readonly OTEL_TEMPO_QUEUE: Queue<ExportPointer>;
  readonly OTEL_LOKI_QUEUE: Queue<ExportPointer>;
  readonly OTEL_PROMETHEUS_QUEUE: Queue<ExportPointer>;
  readonly OTEL_PAYLOAD_STORE?: string;
  readonly OTEL_PAYLOAD_KV?: KVNamespace;
  readonly OTEL_PAYLOAD_D1?: D1Database;
  readonly OTEL_OBJECTS?: R2Bucket;
  // ... rest of OtelEnv remains unchanged
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck --prefix workers`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add workers/migrations/0001_create_otel_payloads.sql workers/src/otel/contracts.ts workers/src/otel/types.ts
git commit -m "feat(otel): D1スキーマ定義とPAYLOAD_STORE_BACKENDSへのd1追加"
```

---

### Task 2: Implement `D1PayloadStore` and Storage Resolvers

**Files:**
- Modify: `workers/src/otel/storage.ts`
- Test: `workers/tests/otel/storage.test.ts`

**Interfaces:**
- Consumes: `PAYLOAD_STORE_BACKENDS`, `PayloadStoreBackend`, `OtelEnv`, `ObjectPointer`, `CurrentObjectPointer`, `PayloadStoreBase`
- Produces:
  - `export class D1PayloadStore extends PayloadStoreBase`
    - `putBytesObject(objectKey: string, bytes: Uint8Array, kind: "ingress" | "export"): Promise<CurrentObjectPointer>`
    - `readBytesObject(pointer: ObjectPointer): Promise<Uint8Array>`
    - `deleteObject(pointer: ObjectPointer): Promise<void>`
    - `deleteExpired(nowSeconds: number): Promise<number>`
  - `resolvePayloadStoreBackend(value: string | undefined): PayloadStoreBackend` (defaults to `"d1"`)
  - `queueDeliveryDelaySeconds(pointer: ObjectPointer): number` (returns 0 for `"d1"`)

- [ ] **Step 1: Write failing unit tests for `D1PayloadStore` in `workers/tests/otel/storage.test.ts`**

Update `workers/tests/otel/storage.test.ts` to add tests for `D1PayloadStore` operations:

```ts
import { D1PayloadStore } from "../../src/otel/storage";

describe("D1 payload store", () => {
  let mockDb: D1Database;
  let store: D1PayloadStore;
  const rows = new Map<string, {
    object_key: string;
    sha256: string;
    content_type: string;
    kind: string;
    data: Uint8Array;
    created_at: number;
    expires_at: number;
  }>();

  beforeEach(() => {
    rows.clear();
    mockDb = {
      prepare(query: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async run() {
                if (query.startsWith("INSERT OR REPLACE")) {
                  const [object_key, sha256, content_type, kind, data, created_at, expires_at] = params as [
                    string, string, string, string, Uint8Array, number, number
                  ];
                  rows.set(object_key, { object_key, sha256, content_type, kind, data, created_at, expires_at });
                  return { success: true, meta: { changes: 1 } };
                }
                if (query.startsWith("DELETE FROM otel_payloads WHERE object_key")) {
                  const [key] = params as [string];
                  rows.delete(key);
                  return { success: true, meta: { changes: 1 } };
                }
                if (query.startsWith("DELETE FROM otel_payloads WHERE expires_at <")) {
                  const [threshold] = params as [number];
                  let changes = 0;
                  for (const [key, row] of rows.entries()) {
                    if (row.expires_at < threshold) {
                      rows.delete(key);
                      changes += 1;
                    }
                  }
                  return { success: true, meta: { changes } };
                }
                return { success: true, meta: { changes: 0 } };
              },
              async first() {
                if (query.startsWith("SELECT data, sha256, content_type")) {
                  const [key] = params as [string];
                  const row = rows.get(key);
                  if (!row) return null;
                  return { data: row.data, sha256: row.sha256, content_type: row.content_type };
                }
                return null;
              },
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1Database;
      },
    } as unknown as D1Database;
    store = new D1PayloadStore(mockDb);
  });

  it("writes and reads JSON payload with integrity verification", async () => {
    const key = "otel/ingress/2026-09-04/test-1.json";
    const pointer = await store.putJsonObject(key, { message: "hello d1" }, "ingress");

    expect(pointer.schemaVersion).toBe(2);
    expect(pointer.storageBackend).toBe("d1");

    const read = await store.readJsonObject<{ message: string }>(pointer);
    expect(read).toEqual({ message: "hello d1" });

    await store.deleteObject(pointer);
    await expect(store.readJsonObject(pointer)).rejects.toThrow(/payload object missing/);
  });

  it("detects checksum mismatch and throws PayloadStoreIntegrityError", async () => {
    const key = "otel/ingress/2026-09-04/tampered.json";
    const pointer = await store.putJsonObject(key, { valid: true }, "ingress");

    // Tamper row data
    const row = rows.get(key)!;
    row.data = new TextEncoder().encode(JSON.stringify({ valid: false }));

    await expect(store.readJsonObject(pointer)).rejects.toThrow(/checksum mismatch/);
  });

  it("purges expired payloads via deleteExpired", async () => {
    const now = Math.floor(Date.now() / 1000);
    rows.set("old", {
      object_key: "old",
      sha256: "a",
      content_type: "application/json",
      kind: "ingress",
      data: new Uint8Array(),
      created_at: now - 800000,
      expires_at: now - 10,
    });
    rows.set("new", {
      object_key: "new",
      sha256: "b",
      content_type: "application/json",
      kind: "ingress",
      data: new Uint8Array(),
      created_at: now,
      expires_at: now + 604800,
    });

    const deleted = await store.deleteExpired(now);
    expect(deleted).toBe(1);
    expect(rows.has("old")).toBe(false);
    expect(rows.has("new")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix workers storage.test.ts`
Expected: FAIL with `D1PayloadStore is not defined`.

- [ ] **Step 3: Implement `D1PayloadStore` and update resolvers in `workers/src/otel/storage.ts`**

In `workers/src/otel/storage.ts`:
1. Add `D1PayloadStore` class:
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
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
        .prepare(
          `SELECT data, sha256, content_type FROM otel_payloads WHERE object_key = ?`,
        )
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
      return (result.meta as { changes?: number })?.changes ?? 0;
    } catch (error) {
      throw classifyStoreFailure(error, "D1 payload purge");
    }
  }
}
```

2. Update `resolvePayloadStoreBackend`:
```ts
export function resolvePayloadStoreBackend(value: string | undefined): PayloadStoreBackend {
  const selected = value?.trim() ?? "";
  if (selected === "") return "d1";
  if (
    selected === PAYLOAD_STORE_BACKENDS[0] ||
    selected === PAYLOAD_STORE_BACKENDS[1] ||
    selected === PAYLOAD_STORE_BACKENDS[2]
  ) {
    return selected;
  }
  throw new PayloadStoreConfigurationError("OTEL_PAYLOAD_STORE must be exactly d1, kv, or r2");
}
```

3. Update `payloadStoreForBackend`:
```ts
function payloadStoreForBackend(env: OtelEnv, backend: PayloadStoreBackend): PayloadStore {
  if (backend === "d1") {
    if (!env.OTEL_PAYLOAD_D1) {
      throw new PayloadStoreConfigurationError("OTEL_PAYLOAD_D1 binding is missing");
    }
    return new D1PayloadStore(env.OTEL_PAYLOAD_D1);
  }
  if (backend === "kv") {
    if (!env.OTEL_PAYLOAD_KV) {
      throw new PayloadStoreConfigurationError("OTEL_PAYLOAD_KV binding is missing");
    }
    return new KvPayloadStore(env.OTEL_PAYLOAD_KV);
  }
  if (!env.OTEL_OBJECTS) {
    throw new PayloadStoreConfigurationError("OTEL_OBJECTS binding is missing");
  }
  return new R2PayloadStore(env.OTEL_OBJECTS);
}
```

4. Update `queueDeliveryDelaySeconds` test assertion: verify delay is 0 for `d1`.
5. Update `classifyStoreFailure` to handle SQLite/D1 errors:
```ts
function classifyStoreFailure(error: unknown, operation: string): PayloadStoreError {
  if (error instanceof PayloadStoreError) return error;
  const message = error instanceof Error ? error.message : "unknown store error";
  if (/quota|daily limit|rate limit|limit exceeded/i.test(message)) {
    return new PayloadStoreQuotaError(`${operation} quota exceeded`);
  }
  if (/database is locked|busy|timeout|network/i.test(message)) {
    return new PayloadStoreTemporaryError(`${operation} temporarily unavailable`);
  }
  return new PayloadStoreTemporaryError(`${operation} temporarily unavailable`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix workers storage.test.ts`
Expected: PASS for all tests.

- [ ] **Step 5: Commit**

```bash
git add workers/src/otel/storage.ts workers/tests/otel/storage.test.ts
git commit -m "feat(otel): D1PayloadStore実装とデフォルトバックエンドのd1化"
```

---

### Task 3: Scheduled Cron Event Handler & Worker Entrypoint

**Files:**
- Modify: `workers/src/otel.ts`
- Modify: `workers/wrangler.otel.jsonc:10-18`
- Create: `workers/tests/otel/scheduled.test.ts`

**Interfaces:**
- Consumes: `D1PayloadStore`, `OtelEnv`
- Produces:
  - `export default.scheduled(event: ScheduledEvent, env: OtelEnv, ctx: ExecutionContext): Promise<void>`
  - Wrangler cron configuration: `"triggers": { "crons": ["0 4 * * *"] }`

- [ ] **Step 1: Write unit test for `scheduled` handler in `workers/tests/otel/scheduled.test.ts`**

Create `workers/tests/otel/scheduled.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/otel";
import { D1PayloadStore } from "../../src/otel/storage";
import type { OtelEnv } from "../../src/otel/types";

describe("OTel Worker scheduled handler", () => {
  it("purges expired payloads when OTEL_PAYLOAD_D1 is configured", async () => {
    const deleteExpiredSpy = vi.spyOn(D1PayloadStore.prototype, "deleteExpired").mockResolvedValue(5);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const mockEnv = {
      OTEL_PAYLOAD_D1: {} as D1Database,
    } as unknown as OtelEnv;

    const event = {
      cron: "0 4 * * *",
      scheduledTime: Date.now(),
      type: "scheduled",
    } as ScheduledEvent;

    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await worker.scheduled(event, mockEnv, ctx);

    expect(deleteExpiredSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Removed 5 expired payload records"));

    deleteExpiredSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("logs and re-throws errors so Cloudflare marks the cron as failed", async () => {
    const purgeError = new Error("D1 temporary lock");
    const deleteExpiredSpy = vi.spyOn(D1PayloadStore.prototype, "deleteExpired").mockRejectedValue(purgeError);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mockEnv = {
      OTEL_PAYLOAD_D1: {} as D1Database,
    } as unknown as OtelEnv;

    const event = { cron: "0 4 * * *", scheduledTime: Date.now(), type: "scheduled" } as ScheduledEvent;
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

    await expect(worker.scheduled(event, mockEnv, ctx)).rejects.toThrow("D1 temporary lock");
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("[D1 Purge] Scheduled purge error:"), purgeError);

    deleteExpiredSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("safely completes when OTEL_PAYLOAD_D1 is undefined", async () => {
    const mockEnv = {} as unknown as OtelEnv;
    const event = { cron: "0 4 * * *", scheduledTime: Date.now(), type: "scheduled" } as ScheduledEvent;
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

    await expect(worker.scheduled(event, mockEnv, ctx)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix workers scheduled.test.ts`
Expected: FAIL with `worker.scheduled is not a function`.

- [ ] **Step 3: Implement `scheduled` handler in `workers/src/otel.ts`**

In `workers/src/otel.ts`:
Add `scheduled` method to the default export object (re-throwing errors so Cloudflare observes the failure, with recovery handled automatically on next cron execution via `WHERE expires_at < now`):
```ts
  async scheduled(
    _event: ScheduledEvent,
    env: OtelEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    if (env.OTEL_PAYLOAD_D1) {
      try {
        const store = new D1PayloadStore(env.OTEL_PAYLOAD_D1);
        const changes = await store.deleteExpired(Math.floor(Date.now() / 1000));
        console.log(`[D1 Purge] Removed ${changes} expired payload records`);
      } catch (error) {
        console.error("[D1 Purge] Scheduled purge error:", error);
        throw error;
      }
    }
  },
```

- [ ] **Step 4: Update `workers/wrangler.otel.jsonc` with triggers and D1 binding**

In `workers/wrangler.otel.jsonc`:
1. Set `"OTEL_PAYLOAD_STORE": "d1"` in `vars`.
2. Add `"triggers"`:
```jsonc
  "triggers": {
    "crons": ["0 4 * * *"]
  },
```
3. Add `"d1_databases"`:
```jsonc
  "d1_databases": [
    {
      "binding": "OTEL_PAYLOAD_D1",
      "database_name": "graft-ai-aig-otel-payloads-v1",
      "database_id": "__OTEL_PAYLOAD_D1_DATABASE_ID__"
    }
  ],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --prefix workers scheduled.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/src/otel.ts workers/wrangler.otel.jsonc workers/tests/otel/scheduled.test.ts
git commit -m "feat(otel): scheduledイベントによるD1有効期限切れペイロード定期削除"
```

---

### Task 4: Config Rendering and Verification Scripts

**Files:**
- Modify: `scripts/render-otel-worker-config.mjs`
- Modify: `scripts/verify-otel-worker-config.mjs`
- Modify: `workers/package.json`
- Modify: `workers/tests/otel-worker-contracts.test.mjs`

**Interfaces:**
- Consumes: `renderOtelWorkerConfig`, `validateOtelWorkerConfig`
- Produces:
  - CLI option `--d1-database-id` in `render-otel-worker-config.mjs`
  - Validation of `d1_databases` in `verify-otel-worker-config.mjs`
  - Render scripts in `workers/package.json` with mock D1 database IDs

- [ ] **Step 1: Write failing tests in `workers/tests/otel-worker-contracts.test.mjs`**

Update `workers/tests/otel-worker-contracts.test.mjs`:
Update the config expectations to check:
- `config.vars.OTEL_PAYLOAD_STORE === "d1"`
- `config.d1_databases[0].binding === "OTEL_PAYLOAD_D1"`
- `config.triggers.crons` includes `"0 4 * * *"`
- `renderOtelWorkerConfig` with `payloadStore: "d1"` and `--d1-database-id`

- [ ] **Step 2: Run test to verify failure**

Run: `node --test workers/tests/otel-worker-contracts.test.mjs`
Expected: FAIL due to missing `--d1-database-id` handling or contract mismatch.

- [ ] **Step 3: Update `scripts/render-otel-worker-config.mjs`**

In `scripts/render-otel-worker-config.mjs`:
1. Add sentinel and pattern:
```javascript
export const OTEL_D1_DATABASE_SENTINEL = "__OTEL_PAYLOAD_D1_DATABASE_ID__";
const d1DatabaseIdPattern =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
```
2. Update allowed stores:
```javascript
const payloadStores = new Set(["kv", "r2", "d1"]);
```
3. Support `--d1-database-id` argument.
4. Validate D1 database ID when `payloadStore === "d1"` and reject unconfigured/invalid IDs (no implicit fallback to all-zero UUID):
```javascript
  if (payloadStore === "d1") {
    if (!d1DatabaseIdPattern.test(d1DatabaseId ?? "")) {
      throw new Error(
        "D1 database ID must be a valid 32-character hexadecimal or UUID string",
      );
    }
  }

  const templateD1Binding = template.d1_databases?.find(
    (entry) => entry.binding === "OTEL_PAYLOAD_D1",
  );
  if (templateD1Binding?.database_id !== OTEL_D1_DATABASE_SENTINEL) {
    throw new Error("template must contain the OTEL_PAYLOAD_D1 database ID sentinel");
  }

  if (d1DatabaseId) {
    if (!d1DatabaseIdPattern.test(d1DatabaseId)) {
      throw new Error(
        "D1 database ID must be a valid 32-character hexadecimal or UUID string",
      );
    }
    rendered.d1_databases = [
      {
        binding: "OTEL_PAYLOAD_D1",
        database_name: templateD1Binding.database_name,
        database_id: d1DatabaseId,
      },
    ];
  } else {
    delete rendered.d1_databases;
  }
```

- [ ] **Step 4: Update `scripts/verify-otel-worker-config.mjs`**

In `scripts/verify-otel-worker-config.mjs`:
1. In `validateStorage`:
   Allow `payloadStore` to be `d1`, `kv`, or `r2`.
   Verify `d1_databases` contains `OTEL_PAYLOAD_D1` with a non-empty `database_id`.
2. In `validateBasicConfig`:
   Verify `triggers.crons` has `["0 4 * * *"]`.

- [ ] **Step 5: Update `workers/package.json` test scripts**

Update `workers/package.json` to pass `--d1-database-id 00000000-0000-0000-0000-000000000000`:
- `render:otel:d1-test`: `--payload-store d1 --kv-namespace-id 00000000000000000000000000000000 --d1-database-id 00000000-0000-0000-0000-000000000000 --output .wrangler/otel.d1.test.jsonc`
- Update other `render:otel:*` scripts to include `--d1-database-id 00000000-0000-0000-0000-000000000000`.

- [ ] **Step 6: Run verification and tests**

Run:
`node scripts/verify-otel-worker-config.mjs`
`node --test workers/tests/otel-worker-contracts.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/render-otel-worker-config.mjs scripts/verify-otel-worker-config.mjs workers/package.json workers/tests/otel-worker-contracts.test.mjs
git commit -m "feat(scripts): OTel Worker設定レンダラーおよび検証スクリプトのD1対応"
```

---

### Task 5: Terraform Infrastructure and Makefile Integration

**Files:**
- Modify: `terraform/otel.tf`
- Modify: `terraform/variables.tf`
- Modify: `terraform/outputs.tf`
- Modify: `Makefile`
- Modify: `tests/deployment-contracts.test.mjs`

**Interfaces:**
- Consumes: Cloudflare D1 Terraform resource in provider v5
- Produces:
  - `cloudflare_d1_database.otel_payloads` resource
  - `otel_d1_database_name` variable
  - `otel_payload_d1_database_id` output
  - Updated `Makefile` targets: `otel-worker-infrastructure`, `render-otel-worker-config`, `deploy-otel-worker`

- [ ] **Step 1: Write failing deployment contract tests in `tests/deployment-contracts.test.mjs`**

Update `tests/deployment-contracts.test.mjs` to check:
- `Makefile` defaults `OTEL_PAYLOAD_STORE ?= d1`
- `Makefile` validates `case "$(OTEL_PAYLOAD_STORE)" in d1|kv|r2)`
- `terraform/otel.tf` contains `cloudflare_d1_database.otel_payloads`

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/deployment-contracts.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Update Terraform configuration**

1. In `terraform/otel.tf`:
Add D1 database resource:
```hcl
resource "cloudflare_d1_database" "otel_payloads" {
  account_id = var.cloudflare_account_id
  name       = var.otel_d1_database_name
}
```

2. In `terraform/variables.tf`:
Add variable:
```hcl
variable "otel_d1_database_name" {
  description = "Fixed name of the dedicated AI Gateway OTel D1 database"
  type        = string
  default     = "graft-ai-aig-otel-payloads-v1"

  validation {
    condition     = var.otel_d1_database_name == "graft-ai-aig-otel-payloads-v1"
    error_message = "otel_d1_database_name is fixed at graft-ai-aig-otel-payloads-v1 to match wrangler.otel.jsonc."
  }
}
```

3. In `terraform/outputs.tf`:
Add output:
```hcl
output "otel_payload_d1_database_id" {
  description = "Cloudflare D1 database ID used by the dedicated OTel Worker payload store"
  value       = cloudflare_d1_database.otel_payloads.id
}
```

- [ ] **Step 4: Update `Makefile`**

1. Update line 3:
```makefile
OTEL_PAYLOAD_STORE ?= d1
```
2. Update validation in `otel-worker-infrastructure` and `render-otel-worker-config`:
```makefile
case "$(OTEL_PAYLOAD_STORE)" in d1|kv|r2) ;; *) printf '%s\n' 'OTEL_PAYLOAD_STORE must be d1, kv, or r2.' >&2; exit 1 ;; esac;
```
3. Update `otel-worker-infrastructure` apply targets to include:
```makefile
-target=cloudflare_d1_database.otel_payloads
```
4. Update `render-otel-worker-config` to strictly require and pass `--d1-database-id` when `OTEL_PAYLOAD_STORE=d1` (rejecting unconfigured values, no implicit all-zero fallback):
```makefile
	d1_flag=""; \
	if [ "$(OTEL_PAYLOAD_STORE)" = d1 ]; then \
	  d1_id="$${OTEL_PAYLOAD_D1_DATABASE_ID:-}"; \
	  case "$$d1_id" in \
	    "") printf '%s\n' 'Set OTEL_PAYLOAD_D1_DATABASE_ID before rendering the OTel Worker config in d1 mode.' >&2; exit 1 ;; \
	  esac; \
	  d1_flag="--d1-database-id $$d1_id"; \
	fi; \
	node scripts/render-otel-worker-config.mjs \
	  --payload-store "$(OTEL_PAYLOAD_STORE)" \
	  --kv-namespace-id "$$namespace_id" \
	  $$d1_flag \
	  --output workers/.wrangler/otel.generated.jsonc $$r2_flag
```
5. Update `deploy-otel-worker` to apply migrations before deployment:
```makefile
deploy-otel-worker: otel-worker-infrastructure
	cd workers && npx wrangler d1 migrations apply graft-ai-aig-otel-payloads-v1 --remote
	$(MAKE) render-otel-worker-config
	cd workers && npx wrangler deploy --config .wrangler/otel.generated.jsonc
```

- [ ] **Step 5: Run tests and terraform validate**

Run:
`node --test tests/deployment-contracts.test.mjs`
`make validate`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add terraform/otel.tf terraform/variables.tf terraform/outputs.tf Makefile tests/deployment-contracts.test.mjs
git commit -m "feat(infra): Terraform D1リソース定義とMakefileデプロイパイプライン統合"
```

---

### Task 6: Documentation Updates and Verification Gate

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `SPEC.md`
- Modify: `SPEC.ja.md`
- Modify: `docs/cloudflare-worker-ai-gateway-otel.md`

**Interfaces:**
- Consumes: Completed implementation and spec
- Produces: Updated documentation reflecting D1 as the default credit-card-free store

- [ ] **Step 1: Update `README.md` and `README.ja.md`**

Document:
- `OTEL_PAYLOAD_STORE=d1` is the new default (100,000 writes/day, 5,000,000 reads/day, 5 GB storage, zero credit card requirement).
- Propagation delay is 0s for D1.
- Detail that `kv` and `r2` remain available via explicit configuration.
- Add migration step note (`wrangler d1 migrations apply`).

- [ ] **Step 2: Update `SPEC.md` and `SPEC.ja.md`**

In § _OTel Worker payload store_:
- Update the default backend description to `OTEL_PAYLOAD_STORE=d1`.
- Document the `otel_payloads` schema, fields, and index.
- Document the daily Cron Trigger (`0 4 * * *` UTC) failsafe cleanup invariant.

- [ ] **Step 3: Update `docs/cloudflare-worker-ai-gateway-otel.md`**

Update the deployment runbook with the D1 database ID variable and migration step.

- [ ] **Step 4: Run all verification gates**

Run:
1. `make fmt`
2. `make typecheck`
3. `make test`
4. `make validate`
Expected: All gates pass cleanly without errors.

- [ ] **Step 5: Commit**

```bash
git add README.md README.ja.md SPEC.md SPEC.ja.md docs/cloudflare-worker-ai-gateway-otel.md
git commit -m "docs: D1ペイロードストア移行に伴うドキュメントおよび仕様書の更新"
```
