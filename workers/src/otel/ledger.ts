import {
  DEDUPLICATION_TOMBSTONE_MS,
  MAX_CONCURRENT_REQUESTS,
  MAX_INGRESS_RESERVATIONS,
  R2_RETENTION_FAILSAFE_MS,
} from "./contracts";
import type { ActiveRequestLease, ExportClaim, ExportPointer, IngressPointer } from "./types";

type Lease = ActiveRequestLease & Readonly<{ ownerId: string }>;
type IngressStatus = "reserved" | "ready" | "enqueued" | "complete" | "expired";
type ExportStatus = "ready" | "enqueued" | "claimed" | "complete" | "expired";

type IngressEntry = Readonly<{
  payloadSha256: string;
  status: IngressStatus;
  pointer?: IngressPointer;
  ownerId: string;
  fencingToken: string;
  tombstoneUntilMs: number;
}>;

type ExportEntry = Readonly<{
  payloadSha256: string;
  status: ExportStatus;
  pointer: ExportPointer;
  claim?: ExportClaim;
  tombstoneUntilMs: number;
}>;

type LedgerState = Readonly<{
  nextFencingToken: number;
  active: Readonly<Record<string, Lease>>;
  ingress: Readonly<Record<string, IngressEntry>>;
  exports: Readonly<Record<string, ExportEntry>>;
}>;

export type ReservationResult = Readonly<{
  kind: "reserved" | "duplicate" | "collision" | "capacity";
  pointer?: IngressPointer;
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
    _env: unknown,
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
      case "ingress.release":
        return this.releaseIngress(
          requiredString(input, "ingressId"),
          requiredString(input, "ownerId"),
          requiredString(input, "fencingToken"),
        );
      case "export.register":
        return this.registerExport(
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
      case "export.complete":
        return this.completeExport(readClaim(input["claim"]));
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
      expiresAtMs: nowMs + 30_000,
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
      return { kind: "duplicate", pointer: existing.pointer };
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
    };
    await this.writeState({ ...state, ingress: { ...state.ingress, [input.ingressId]: entry } });
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

  async getIngress(ingressId: string): Promise<IngressRecord | null> {
    const state = await this.readState(Date.now());
    const entry = state.ingress[ingressId];
    return entry
      ? { status: entry.status, payloadSha256: entry.payloadSha256, pointer: entry.pointer }
      : null;
  }

  async registerExport(
    pointer: ExportPointer,
    nowMs: number,
  ): Promise<"reserved" | "duplicate" | "collision"> {
    const state = await this.readState(nowMs);
    const existing = state.exports[pointer.jobId];
    if (existing) {
      return existing.payloadSha256 === pointer.payloadSha256 ? "duplicate" : "collision";
    }
    const entry: ExportEntry = {
      payloadSha256: pointer.payloadSha256,
      status: "ready",
      pointer,
      tombstoneUntilMs: nowMs + DEDUPLICATION_TOMBSTONE_MS,
    };
    await this.writeState({ ...state, exports: { ...state.exports, [pointer.jobId]: entry } });
    return "reserved";
  }

  async markExportEnqueued(jobId: string): Promise<boolean> {
    const state = await this.readState(Date.now());
    const entry = state.exports[jobId];
    if (!entry) return false;
    if (entry.status === "enqueued") return true;
    if (entry.status !== "ready") return false;
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

  async alarm(): Promise<void> {
    const state = await this.readState(Date.now());
    await this.writeState(state);
  }

  private async readState(nowMs: number): Promise<LedgerState> {
    const stored = await this.state.storage.get<LedgerState>("state");
    const state = stored ?? { nextFencingToken: 1, active: {}, ingress: {}, exports: {} };
    const ingress = Object.fromEntries(
      Object.entries(state.ingress).filter(([_, entry]) =>
        entry.status === "ready" || entry.status === "enqueued"
          ? entry.tombstoneUntilMs + R2_RETENTION_FAILSAFE_MS > nowMs
          : entry.tombstoneUntilMs > nowMs,
      ),
    );
    const exports = Object.fromEntries(
      Object.entries(state.exports).filter(([_, entry]) => entry.tombstoneUntilMs > nowMs),
    );
    return { ...state, ingress, exports };
  }

  private async writeState(state: LedgerState): Promise<void> {
    await this.state.storage.put("state", state);
  }
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
