import { timingSafeSecretEqual } from "../crypto";
import { MAX_INGRESS_BYTES } from "./contracts";
import { ledgerCall, type ReservationResult } from "./ledger";
import { parseOtlpJson } from "./otlp";
import { redactSpan } from "./redaction";
import type { RateLimitResult } from "./rate-limit";
import { ingressObjectKey, putJsonObject, sha256Hex } from "./storage";
import type {
  ActiveRequestLease,
  IngressPointer,
  MetricSample,
  OtelEnv,
  RedactedSpan,
} from "./types";

const BODY_DEADLINE_MS = 30_000;
export type OtelIngressEnvelope = Readonly<{
  schemaVersion: 1;
  spans: readonly RedactedSpan[];
}>;

type BodyReadResult =
  | Readonly<{ kind: "ok"; text: string }>
  | Readonly<{ kind: "too_large" | "timeout" | "invalid_utf8" }>;

export async function handleIngress(request: Request, env: OtelEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/traces") return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authorization = request.headers.get("authorization");
  if (!env.OTEL_INGEST_TOKEN) return json({ error: "misconfigured" }, 503);
  if (!authorization?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const token = authorization.slice("Bearer ".length);
  if (!token || !(await timingSafeSecretEqual(token, env.OTEL_INGEST_TOKEN))) {
    return json({ error: "unauthorized" }, 401);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return json({ error: "unsupported_media_type" }, 415);
  const contentEncoding =
    request.headers.get("content-encoding")?.trim().toLowerCase() ?? "identity";
  if (contentEncoding !== "identity") return json({ error: "unsupported_encoding" }, 415);

  const ownerId = crypto.randomUUID();
  const acquiredAtMs = Date.now();
  const ledger = env.OTEL_LEDGER.getByName("global");
  let lease: ActiveRequestLease | null = null;
  try {
    lease = await ledgerCall<ActiveRequestLease | null>(ledger, "active.acquire", {
      ownerId,
      nowMs: acquiredAtMs,
    });
    if (!lease) return responseWithHeaders({ error: "busy" }, 503, { "retry-after": "1" });

    const sourceHash = await sourceHashFor(
      request.headers.get("cf-connecting-ip"),
      env.OTEL_RATE_LIMIT_HMAC_KEY,
    );
    const nowMs = Date.now();
    const rateLimit = await rateLimitTake(env, sourceHash, nowMs);
    if (!rateLimit.allowed) {
      await appendOperationalMetric(env, "otel_ingress_rate_limited_total");
      return responseWithHeaders({ error: "rate_limited" }, 429, {
        "retry-after": String(rateLimit.retryAfterSeconds),
      });
    }

    const body = await readBody(request);
    if (body.kind !== "ok") {
      if (body.kind === "too_large") return json({ error: "payload_too_large" }, 413);
      if (body.kind === "timeout") return json({ error: "request_timeout" }, 408);
      return json({ error: "invalid_utf8" }, 400);
    }

    let envelope: OtelIngressEnvelope;
    try {
      const parsed: unknown = JSON.parse(body.text);
      const spans = parseOtlpJson(parsed).map(redactSpan);
      envelope = { schemaVersion: 1, spans };
    } catch {
      return json({ error: "invalid_otlp_json" }, 400);
    }

    const serialized = JSON.stringify(envelope);
    const bytes = new TextEncoder().encode(serialized);
    const payloadSha256 = await sha256Hex(bytes);
    const ingressId = await sha256Hex(
      new TextEncoder().encode(`graft-ai-otel-ingress-v1\0${serialized}`),
    );
    const reservation = await ledgerCall<ReservationResult>(ledger, "ingress.reserve", {
      ingressId,
      payloadSha256,
      ownerId,
      fencingToken: lease.fencingToken,
      nowMs,
    });
    if (reservation.kind === "duplicate") {
      if (reservation.status === "complete" || reservation.status === "enqueued") return accepted();
      if (reservation.status === "ready" && reservation.pointer) {
        try {
          await env.OTEL_INGRESS_QUEUE.send(reservation.pointer);
          await ledgerCall(ledger, "ingress.enqueued", {
            ingressId,
            ownerId: reservation.ownerId,
            fencingToken: reservation.fencingToken,
          });
          return accepted();
        } catch {
          return json({ error: "queue_failed" }, 503);
        }
      }
      return responseWithHeaders({ error: "busy" }, 503, { "retry-after": "1" });
    }
    if (reservation.kind === "collision") return json({ error: "ingress_collision" }, 409);
    if (reservation.kind === "capacity") {
      await appendOperationalMetric(env, "otel_ingress_queue_dropped_total");
      return responseWithHeaders({ reason: "capacity" }, 200, { "x-otel-drop-reason": "capacity" });
    }

    let pointer: IngressPointer;
    try {
      const objectKey = ingressObjectKey(ingressId, new Date(nowMs).toISOString().slice(0, 10));
      const object = await putJsonObject(env.OTEL_OBJECTS, objectKey, envelope);
      pointer = { ...object, kind: "ingress", ingressId };
    } catch {
      await releaseReservation(ledger, ingressId, ownerId, lease.fencingToken);
      return json({ error: "persistence_failed" }, 503);
    }

    try {
      await ledgerCall(ledger, "ingress.ready", {
        ingressId,
        pointer,
        ownerId,
        fencingToken: lease.fencingToken,
      });
    } catch {
      const released = await releaseReservation(ledger, ingressId, ownerId, lease.fencingToken);
      if (released) await env.OTEL_OBJECTS.delete(pointer.objectKey);
      return json({ error: "persistence_failed" }, 503);
    }
    try {
      await env.OTEL_INGRESS_QUEUE.send(pointer);
      await ledgerCall(ledger, "ingress.enqueued", {
        ingressId,
        ownerId,
        fencingToken: lease.fencingToken,
      });
    } catch {
      return json({ error: "queue_failed" }, 503);
    }
    return accepted();
  } catch {
    return json({ error: "ingress_failed" }, 503);
  } finally {
    if (lease) {
      try {
        await ledgerCall(ledger, "active.release", {
          ownerId,
          fencingToken: lease.fencingToken,
        });
      } catch {}
    }
  }
}

async function releaseReservation(
  ledger: DurableObjectStub,
  ingressId: string,
  ownerId: string,
  fencingToken: string,
): Promise<boolean> {
  try {
    return await ledgerCall<boolean>(ledger, "ingress.release", {
      ingressId,
      ownerId,
      fencingToken,
    });
  } catch {
    return false;
  }
}

async function rateLimitTake(
  env: OtelEnv,
  sourceHash: string,
  nowMs: number,
): Promise<RateLimitResult> {
  const response = await env.OTEL_RATE_LIMIT.getByName(sourceHash).fetch(
    "https://rate-limit/take",
    {
      method: "POST",
      body: JSON.stringify({ nowMs }),
    },
  );
  if (!response.ok) throw new Error(`rate limiter rejected: ${response.status}`);
  return (await response.json()) as RateLimitResult;
}

async function appendOperationalMetric(env: OtelEnv, name: string): Promise<void> {
  const sample: MetricSample = {
    sampleId: `${name}:${crypto.randomUUID()}`,
    name,
    kind: "sum",
    value: 1,
    labels: {
      model: "unknown",
      provider: "unknown",
      status_code: "unknown",
      env: env.ENV_LABEL,
      gateway: env.GATEWAY_NAME,
    },
  };
  try {
    await env.OTEL_METRICS_AGGREGATE.getByName("global").fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({ samples: [sample], nowMs: Date.now() }),
    });
  } catch {}
}

async function sourceHashFor(source: string | null, hmacSecret: string): Promise<string> {
  const canonical = canonicalSource(source);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(hmacSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`otel-ingress-source-v1\0${canonical}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalSource(value: string | null): string {
  const source = value?.trim() ?? "";
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(source)) {
    const octets = source.split(".").map(Number);
    if (octets.every((octet) => octet >= 0 && octet <= 255)) return octets.join(".");
  }
  const ipv6 = source.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^[0-9a-f:]+$/.test(ipv6) && ipv6.includes(":")) return ipv6;
  return "unknown";
}

async function readBody(request: Request): Promise<BodyReadResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_INGRESS_BYTES) return { kind: "too_large" };
  }
  if (!request.body) return { kind: "ok", text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readPromise = (async (): Promise<BodyReadResult> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_INGRESS_BYTES) {
        await reader.cancel();
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return {
        kind: "ok",
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
      };
    } catch {
      return { kind: "invalid_utf8" };
    }
  })();
  const timeoutPromise = new Promise<BodyReadResult>((resolve) => {
    timer = setTimeout(() => {
      void reader.cancel();
      resolve({ kind: "timeout" });
    }, BODY_DEADLINE_MS);
  });
  const result = await Promise.race([readPromise, timeoutPromise]);
  if (result.kind === "timeout") void readPromise.catch(() => undefined);
  if (timer) clearTimeout(timer);
  return result;
}

function accepted(): Response {
  return json({ reason: "accepted" }, 200);
}

function json(value: unknown, status: number): Response {
  return Response.json(value, { status });
}

function responseWithHeaders(
  value: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
