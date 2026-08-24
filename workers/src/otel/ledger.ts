import {
  ACTIVE_REQUEST_LEASE_MS,
  DEDUPLICATION_TOMBSTONE_MS,
  MAX_CONCURRENT_REQUESTS,
  MAX_INGRESS_RESERVATIONS,
  PAYLOAD_RETENTION_FAILSAFE_MS,
} from "./contracts";
import type {
  ActiveRequestLease,
  ExportClaim,
  ExportPointer,
  IngressPointer,
  JobDescriptor,
  MetricSample,
  OtelEnv,
} from "./types";
import { payloadStoreForPointer, queueDeliveryDelaySeconds } from "./storage";

type Lease = ActiveRequestLease & Readonly<{ ownerId: string }>;
type IngressStatus = "reserved" | "ready" | "enqueued" | "complete" | "expired";
type ExportStatus = "reserved" | "ready" | "enqueued" | "claimed" | "complete" | "expired";

type IngressEntry = Readonly<{
  payloadSha256: string;
  status: IngressStatus;
  pointer?: IngressPointer;
  ownerId: string;
  fencingToken: string;
  tombstoneUntilMs: number;
  payloadReadFailures?: number;
}>;

type ExportEntry = Readonly<{
  payloadSha256: string;
  status: ExportStatus;
  pointer?: ExportPointer;
  claim?: ExportClaim;
  tombstoneUntilMs: number;
  payloadReadFailures?: number;
  downstreamFailures?: number;
}>;

type LedgerState = Readonly<{
  nextFencingToken: number;
  active: Readonly<Record<string, Lease>>;
  ingress: Readonly<Record<string, IngressEntry>>;
  exports: Readonly<Record<string, ExportEntry>>;
}>;

export type ReservationResult =
  | Readonly<{
      kind: "reserved";
    }>
  | Readonly<{
      kind: "duplicate";
      status: IngressStatus;
      pointer?: IngressPointer;
      ownerId: string;
      fencingToken: string;
    }>
  | Readonly<{
      kind: "collision" | "capacity";
    }>;

export type ExportRegistrationResult =
  | Readonly<{
      kind: "reserved";
    }>
  | Readonly<{
      kind: "duplicate";
      status: ExportStatus;
      pointer?: ExportPointer;
    }>
  | Readonly<{
      kind: "collision";
    }>;

export type ExportClaimResult =
  | Readonly<{ kind: "claimed"; claim: ExportClaim; pointer: ExportPointer }>
  | Readonly<{ kind: "busy" | "complete" | "expired" | "missing" }>;

export type IngressRecord = Readonly<{
  status: IngressStatus;
  payloadSha256: string;
  pointer?: IngressPointer;
}>;

export class LedgerStaleError extends Error {
  readonly name = "LedgerStaleError";
}

export class OtelLedger {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: OtelEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return this.state.blockConcurrencyWhile(async () => {
      const body: unknown = await request.json();
      return Response.json(await this.dispatch(body));
    });
  }

  private async dispatch(value: unknown): Promise<unknown> {
    if (!isRecord(value) || typeof value["operation"] !== "string") {
      throw new TypeError("invalid ledger operation");
    }
    const input = value;
    switch (input["operation"]) {
      case "active.acquire":
        return this.acquireActive(requiredString(input, "ownerId"), requiredNumber(input, "nowMs"));
      case "active.release":
        return this.releaseActive(
          requiredString(input, "ownerId"),
          requiredString(input, "fencingToken"),
        );
      case "ingress.reserve":
        return this.reserveIngress({
          ingressId: requiredString(input, "ingressId"),
          payloadSha256: requiredString(input, "payloadSha256"),
          ownerId: requiredString(input, "ownerId"),
          fencingToken: requiredString(input, "fencingToken"),
          nowMs: requiredNumber(input, "nowMs"),
        });
      case "ingress.record":
        return this.getIngress(requiredString(input, "ingressId"));
      case "ingress.ready":
        await this.markIngressReady(
          requiredString(input, "ingressId"),
          readIngressPointer(input["pointer"]),
          requiredString(input, "ownerId"),
          requiredString(input, "fencingToken"),
        );
        return { ok: true };
      case "ingress.enqueued":
        await this.markIngressEnqueued(
          requiredString(input, "ingressId"),
          requiredString(input, "ownerId"),
          requiredString(input, "fencingToken"),
        );
        return { ok: true };
      case "ingress.complete":
        return this.completeIngress(requiredString(input, "ingressId"));
      case "ingress.payload-read-failure":
        return this.recordIngressPayloadReadFailure(requiredString(input, "ingressId"));
      case "ingress.release":
        return this.releaseIngress(
          requiredString(input, "ingressId"),
          requiredString(input, "ownerId"),
          requiredString(input, "fencingToken"),
        );
      case "export.register":
        return this.registerExport(
          readJobDescriptor(input["descriptor"]),
          requiredNumber(input, "nowMs"),
        );
      case "export.ready":
        return this.markExportReady(
          requiredString(input, "jobId"),
          readExportPointer(input["pointer"]),
          requiredNumber(input, "nowMs"),
        );
      case "export.enqueued":
        return this.markExportEnqueued(requiredString(input, "jobId"));
      case "export.claim":
        return this.claimExport(
          requiredString(input, "jobId"),
          requiredString(input, "ownerId"),
          requiredNumber(input, "nowMs"),
        );
      case "export.release":
        return this.releaseExport(readClaim(input["claim"]));
      case "export.release-reservation":
        return this.releaseExportReservation(requiredString(input, "jobId"));
      case "export.complete":
        return this.completeExport(readClaim(input["claim"]));
      case "export.payload-read-failure":
        return this.recordExportPayloadReadFailure(requiredString(input, "jobId"));
      case "export.downstream-failure":
        return this.recordExportDownstreamFailure(requiredString(input, "jobId"));
      default:
        throw new TypeError("unknown ledger operation");
    }
  }

  async acquireActive(ownerId: string, nowMs: number): Promise<ActiveRequestLease | null> {
    const state = await this.readState(nowMs);
    const active = Object.fromEntries(
      Object.entries(state.active).filter(([, lease]) => lease.expiresAtMs > nowMs),
    );
    if (Object.keys(active).length >= MAX_CONCURRENT_REQUESTS) {
      await this.writeState({ ...state, active });
      return null;
    }
    const lease = {
      ownerId,
      fencingToken: String(state.nextFencingToken),
      expiresAtMs: nowMs + ACTIVE_REQUEST_LEASE_MS,
    } satisfies Lease;
    await this.writeState({
      ...state,
      nextFencingToken: state.nextFencingToken + 1,
      active: { ...active, [ownerId]: lease },
    });
    return lease;
  }

  async releaseActive(ownerId: string, fencingToken: string): Promise<boolean> {
    const state = await this.readState(Date.now());
    const lease = state.active[ownerId];
    if (!lease || lease.fencingToken !== fencingToken) return false;
    const active = { ...state.active };
    delete active[ownerId];
    await this.writeState({ ...state, active });
    return true;
  }

  async reserveIngress(
    input: Readonly<{
      ingressId: string;
      payloadSha256: string;
      ownerId: string;
      fencingToken: string;
      nowMs: number;
    }>,
  ): Promise<ReservationResult> {
    const state = await this.readState(input.nowMs);
    const existing = state.ingress[input.ingressId];
    if (existing) {
      if (existing.payloadSha256 !== input.payloadSha256) return { kind: "collision" };
      return {
        kind: "duplicate",
        status: existing.status,
        ...(existing.pointer ? { pointer: existing.pointer } : {}),
        ownerId: existing.ownerId,
        fencingToken: existing.fencingToken,
      };
    }
    const pending = Object.values(state.ingress).filter((entry) =>
      ["reserved", "ready", "enqueued"].includes(entry.status),
    ).length;
    if (pending >= MAX_INGRESS_RESERVATIONS) return { kind: "capacity" };
    const entry: IngressEntry = {
      payloadSha256: input.payloadSha256,
      status: "reserved",
      ownerId: input.ownerId,
      fencingToken: input.fencingToken,
      tombstoneUntilMs: input.nowMs + DEDUPLICATION_TOMBSTONE_MS,
      payloadReadFailures: 0,
    };
    await this.writeState({ ...state, ingress: { ...state.ingress, [input.ingressId]: entry } });
    await this.scheduleAlarm(input.nowMs + DEDUPLICATION_TOMBSTONE_MS);
    return { kind: "reserved" };
  }

  async markIngressReady(
    ingressId: string,
    pointer: IngressPointer,
    ownerId: string,
    fencingToken: string,
  ): Promise<void> {
    const state = await this.readState(Date.now());
    const entry = state.ingress[ingressId];
    assertLease(entry, ownerId, fencingToken, "ingress");
    if (entry.status !== "reserved") throw new LedgerStaleError("invalid ingress transition");
    await this.writeState({
      ...state,
      ingress: {
        ...state.ingress,
        [ingressId]: { ...entry, status: "ready", pointer },
      },
    });
    await this.scheduleAlarm(Date.now() + 1_000);
  }

  async markIngressEnqueued(
    ingressId: string,
    ownerId: string,
    fencingToken: string,
  ): Promise<void> {
    const state = await this.readState(Date.now());
    const entry = state.ingress[ingressId];
    assertLease(entry, ownerId, fencingToken, "ingress");
    if (entry.status !== "ready" || !entry.pointer)
      throw new LedgerStaleError("invalid ingress transition");
    await this.writeState({
      ...state,
      ingress: { ...state.ingress, [ingressId]: { ...entry, status: "enqueued" } },
    });
  }

  async releaseIngress(ingressId: string, ownerId: string, fencingToken: string): Promise<boolean> {
    const state = await this.readState(Date.now());
    const entry = state.ingress[ingressId];
    assertLease(entry, ownerId, fencingToken, "ingress");
    if (entry.status !== "reserved") return false;
    const ingress = { ...state.ingress };
    delete ingress[ingressId];
    await this.writeState({ ...state, ingress });
    return true;
  }

  async completeIngress(ingressId: string): Promise<boolean> {
    const state = await this.readState(Date.now());
    const entry = state.ingress[ingressId];
    if (!entry) return false;
    if (entry.status === "complete") return true;
    if ((entry.status !== "ready" && entry.status !== "enqueued") || !entry.pointer) return false;
    await this.writeState({
      ...state,
      ingress: { ...state.ingress, [ingressId]: { ...entry, status: "complete" } },
    });
    return true;
  }

  async recordIngressPayloadReadFailure(ingressId: string): Promise<number> {
    const state = await this.readState(Date.now());
    const entry = state.ingress[ingressId];
    if (!entry) throw new LedgerStaleError("ingress entry missing");
    const payloadReadFailures = (entry.payloadReadFailures ?? 0) + 1;
    await this.writeState({
      ...state,
      ingress: {
        ...state.ingress,
        [ingressId]: { ...entry, payloadReadFailures },
      },
    });
    return payloadReadFailures;
  }

  async getIngress(ingressId: string): Promise<IngressRecord | null> {
    const state = await this.readState(Date.now());
    const entry = state.ingress[ingressId];
    return entry
      ? { status: entry.status, payloadSha256: entry.payloadSha256, pointer: entry.pointer }
      : null;
  }

  async registerExport(
    descriptor: JobDescriptor,
    nowMs: number,
  ): Promise<ExportRegistrationResult> {
    const state = await this.readState(nowMs);
    const existing = state.exports[descriptor.jobId];
    if (existing) {
      if (existing.payloadSha256 !== descriptor.payloadSha256) return { kind: "collision" };
      return {
        kind: "duplicate",
        status: existing.status,
        ...(existing.pointer ? { pointer: existing.pointer } : {}),
      };
    }
    const entry: ExportEntry = {
      payloadSha256: descriptor.payloadSha256,
      status: "reserved",
      tombstoneUntilMs: nowMs + DEDUPLICATION_TOMBSTONE_MS,
      payloadReadFailures: 0,
      downstreamFailures: 0,
    };
    await this.writeState({ ...state, exports: { ...state.exports, [descriptor.jobId]: entry } });
    await this.scheduleAlarm(nowMs + DEDUPLICATION_TOMBSTONE_MS);
    return { kind: "reserved" };
  }

  async markExportReady(jobId: string, pointer: ExportPointer, nowMs: number): Promise<boolean> {
    const state = await this.readState(nowMs);
    const entry = state.exports[jobId];
    if (!entry || entry.payloadSha256 !== pointer.payloadSha256) return false;
    if (entry.status !== "reserved") {
      return Boolean(entry.pointer && entry.pointer.objectKey === pointer.objectKey);
    }
    await this.writeState({
      ...state,
      exports: { ...state.exports, [jobId]: { ...entry, status: "ready", pointer } },
    });
    await this.scheduleAlarm(Date.now() + 1_000);
    return true;
  }

  async markExportEnqueued(jobId: string): Promise<boolean> {
    const state = await this.readState(Date.now());
    const entry = state.exports[jobId];
    if (!entry) return false;
    if (entry.status === "enqueued") return true;
    if (entry.status !== "ready" || !entry.pointer) return false;
    await this.writeState({
      ...state,
      exports: { ...state.exports, [jobId]: { ...entry, status: "enqueued" } },
    });
    return true;
  }

  async claimExport(jobId: string, ownerId: string, nowMs: number): Promise<ExportClaimResult> {
    const state = await this.readState(nowMs);
    const entry = state.exports[jobId];
    if (!entry) return { kind: "missing" };
    if (entry.status === "complete") return { kind: "complete" };
    if (entry.status === "expired") return { kind: "expired" };
    if (entry.status === "reserved" || !entry.pointer) return { kind: "busy" };
    if (entry.status === "claimed" && entry.claim && entry.claim.expiresAtMs > nowMs)
      return { kind: "busy" };
    const claim: ExportClaim = {
      ownerId,
      jobId,
      fencingToken: String(state.nextFencingToken),
      expiresAtMs: nowMs + 30_000,
    };
    await this.writeState({
      ...state,
      nextFencingToken: state.nextFencingToken + 1,
      exports: { ...state.exports, [jobId]: { ...entry, status: "claimed", claim } },
    });
    await this.scheduleAlarm(claim.expiresAtMs);
    return { kind: "claimed", claim, pointer: entry.pointer };
  }

  async releaseExport(claim: ExportClaim): Promise<boolean> {
    const state = await this.readState(Date.now());
    const entry = state.exports[claim.jobId];
    if (!entry || entry.status !== "claimed" || !sameClaim(entry.claim, claim)) return false;
    await this.writeState({
      ...state,
      exports: {
        ...state.exports,
        [claim.jobId]: { ...entry, status: "enqueued", claim: undefined },
      },
    });
    return true;
  }

  async releaseExportReservation(jobId: string): Promise<boolean> {
    const state = await this.readState(Date.now());
    const entry = state.exports[jobId];
    if (!entry || entry.status !== "reserved") return false;
    const exports = { ...state.exports };
    delete exports[jobId];
    await this.writeState({ ...state, exports });
    return true;
  }

  async completeExport(claim: ExportClaim): Promise<boolean> {
    const state = await this.readState(Date.now());
    const entry = state.exports[claim.jobId];
    if (!entry || entry.status === "complete") return entry?.status === "complete";
    if (entry.status !== "claimed" || !sameClaim(entry.claim, claim)) return false;
    await this.writeState({
      ...state,
      exports: {
        ...state.exports,
        [claim.jobId]: { ...entry, status: "complete", claim: undefined },
      },
    });
    return true;
  }

  async recordExportPayloadReadFailure(jobId: string): Promise<number> {
    const state = await this.readState(Date.now());
    const entry = state.exports[jobId];
    if (!entry) throw new LedgerStaleError("export entry missing");
    const payloadReadFailures = (entry.payloadReadFailures ?? 0) + 1;
    await this.writeState({
      ...state,
      exports: {
        ...state.exports,
        [jobId]: { ...entry, payloadReadFailures },
      },
    });
    return payloadReadFailures;
  }

  async recordExportDownstreamFailure(jobId: string): Promise<number> {
    const state = await this.readState(Date.now());
    const entry = state.exports[jobId];
    if (!entry) throw new LedgerStaleError("export entry missing");
    const downstreamFailures = (entry.downstreamFailures ?? 0) + 1;
    await this.writeState({
      ...state,
      exports: {
        ...state.exports,
        [jobId]: { ...entry, downstreamFailures },
      },
    });
    return downstreamFailures;
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const nowMs = Date.now();
      const state = await this.readState(nowMs);
      const ingress = { ...state.ingress };
      const exports = { ...state.exports };
      const expiredPointers: Array<IngressPointer | ExportPointer> = [];
      let nextAlarmMs: number | null = null;

      for (const [ingressId, entry] of Object.entries(ingress)) {
        if (isRetentionExpired(entry, nowMs)) {
          if (entry.pointer) expiredPointers.push(entry.pointer);
          ingress[ingressId] = { ...entry, status: "expired" };
          continue;
        }
        if (entry.status === "ready" && entry.pointer) {
          try {
            await sendPointer(this.env, entry.pointer);
            ingress[ingressId] = { ...entry, status: "enqueued" };
          } catch {
            nextAlarmMs = earliestAlarm(nextAlarmMs, nowMs + 1_000);
          }
        }
        nextAlarmMs = retentionAlarm(nextAlarmMs, entry, nowMs);
      }

      for (const [jobId, entry] of Object.entries(exports)) {
        if (isRetentionExpired(entry, nowMs)) {
          if (entry.pointer) expiredPointers.push(entry.pointer);
          exports[jobId] = { ...entry, status: "expired", claim: undefined };
          continue;
        }
        if (entry.status === "claimed" && entry.claim && entry.claim.expiresAtMs <= nowMs) {
          exports[jobId] = { ...entry, status: "enqueued", claim: undefined };
        } else if (entry.status === "ready" && entry.pointer) {
          try {
            await sendPointer(this.env, entry.pointer);
            exports[jobId] = { ...entry, status: "enqueued" };
          } catch {
            nextAlarmMs = earliestAlarm(nextAlarmMs, nowMs + 1_000);
          }
        }
        const current = exports[jobId] ?? entry;
        nextAlarmMs = retentionAlarm(nextAlarmMs, current, nowMs);
        if (current.status === "claimed" && current.claim) {
          nextAlarmMs = earliestAlarm(nextAlarmMs, current.claim.expiresAtMs);
        }
      }

      await this.writeState({ ...state, ingress, exports });
      for (const pointer of expiredPointers) {
        await this.expirePointer(pointer);
      }
      if (nextAlarmMs !== null) await this.state.storage.setAlarm(nextAlarmMs);
    });
  }

  private async readState(nowMs: number): Promise<LedgerState> {
    const stored = await this.state.storage.get<LedgerState>("state");
    const state = stored ?? { nextFencingToken: 1, active: {}, ingress: {}, exports: {} };
    const ingress = Object.fromEntries(
      Object.entries(state.ingress).filter(([_, entry]) =>
        entry.status === "ready" || entry.status === "enqueued"
          ? true
          : entry.tombstoneUntilMs > nowMs,
      ),
    );
    const exports = Object.fromEntries(
      Object.entries(state.exports).filter(([_, entry]) =>
        entry.status === "ready" || entry.status === "enqueued" || entry.status === "claimed"
          ? true
          : entry.tombstoneUntilMs > nowMs,
      ),
    );
    return { ...state, ingress, exports };
  }

  private async expirePointer(pointer: IngressPointer | ExportPointer): Promise<void> {
    try {
      await payloadStoreForPointer(this.env, pointer).deleteObject(pointer);
    } catch {}
    try {
      const sample: MetricSample = {
        sampleId: `payload-retention:${pointer.kind}:${pointer.id}`,
        name: "otel_payload_retention_expired_total",
        kind: "sum",
        value: 1,
        labels: {
          kind: pointer.kind,
          storage_backend: pointer.schemaVersion === 1 ? "r2" : pointer.storageBackend,
        },
      };
      await this.env.OTEL_METRICS_AGGREGATE.getByName("global").fetch("https://metrics/append", {
        method: "POST",
        body: JSON.stringify({ samples: [sample], nowMs: Date.now() }),
      });
    } catch {}
  }

  private async writeState(state: LedgerState): Promise<void> {
    await this.state.storage.put("state", state);
  }

  private async scheduleAlarm(deadlineMs: number): Promise<void> {
    const scheduled = await this.state.storage.getAlarm();
    if (scheduled === null || deadlineMs < scheduled) {
      await this.state.storage.setAlarm(deadlineMs);
    }
  }
}

function isRetentionExpired(entry: IngressEntry | ExportEntry, nowMs: number): boolean {
  return (
    (entry.status === "ready" || entry.status === "enqueued" || entry.status === "claimed") &&
    entry.tombstoneUntilMs + PAYLOAD_RETENTION_FAILSAFE_MS <= nowMs
  );
}

function retentionAlarm(
  current: number | null,
  entry: IngressEntry | ExportEntry,
  nowMs: number,
): number | null {
  if (entry.status !== "ready" && entry.status !== "enqueued" && entry.status !== "claimed") {
    return current;
  }
  const deadline = entry.tombstoneUntilMs + PAYLOAD_RETENTION_FAILSAFE_MS;
  return deadline > nowMs ? earliestAlarm(current, deadline) : current;
}

function earliestAlarm(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
}

async function sendPointer(env: OtelEnv, pointer: IngressPointer | ExportPointer): Promise<void> {
  const queue: Queue<IngressPointer | ExportPointer> =
    pointer.kind === "ingress"
      ? env.OTEL_INGRESS_QUEUE
      : pointer.backend === "tempo"
        ? env.OTEL_TEMPO_QUEUE
        : pointer.backend === "loki"
          ? env.OTEL_LOKI_QUEUE
          : env.OTEL_PROMETHEUS_QUEUE;
  await queue.send(pointer, {
    delaySeconds: queueDeliveryDelaySeconds(pointer),
  });
}

export async function ledgerCall<T>(
  stub: DurableObjectStub,
  operation: string,
  input: Readonly<Record<string, unknown>> = {},
): Promise<T> {
  const response = await stub.fetch("https://ledger/rpc", {
    method: "POST",
    body: JSON.stringify({ operation, ...input }),
  });
  if (!response.ok) throw new Error(`ledger request failed: ${response.status}`);
  return (await response.json()) as T;
}

function assertLease(
  entry: IngressEntry | undefined,
  ownerId: string,
  fencingToken: string,
  kind: string,
): asserts entry is IngressEntry {
  if (!entry || entry.ownerId !== ownerId || entry.fencingToken !== fencingToken) {
    throw new LedgerStaleError(`stale ${kind} lease`);
  }
}

function sameClaim(left: ExportClaim | undefined, right: ExportClaim): boolean {
  return Boolean(
    left &&
    left.ownerId === right.ownerId &&
    left.jobId === right.jobId &&
    left.fencingToken === right.fencingToken,
  );
}

function readExportPointer(value: unknown): ExportPointer {
  if (!isRecord(value)) throw new TypeError("invalid export pointer");
  return value as ExportPointer;
}

function readJobDescriptor(value: unknown): JobDescriptor {
  if (!isRecord(value)) throw new TypeError("invalid job descriptor");
  return value as JobDescriptor;
}

function readIngressPointer(value: unknown): IngressPointer {
  if (!isRecord(value)) throw new TypeError("invalid ingress pointer");
  return value as IngressPointer;
}

function readClaim(value: unknown): ExportClaim {
  if (!isRecord(value)) throw new TypeError("invalid export claim");
  return value as ExportClaim;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid ${key}`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`invalid ${key}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
