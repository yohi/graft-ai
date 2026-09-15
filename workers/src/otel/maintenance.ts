import { timingSafeSecretEqual } from "../crypto";
import { TRACE_AGGREGATE_INTERNAL_CLEANUP_PATH } from "./trace-aggregate";
import type { TraceCleanupResult } from "./trace-aggregate";
import type { OtelEnv } from "./types";

export const TRACE_AGGREGATE_CLEANUP_PATH = "/_admin/trace-aggregate/cleanup";

const TRACE_AGGREGATE_INTERNAL_CLEANUP_URL = `https://trace${TRACE_AGGREGATE_INTERNAL_CLEANUP_PATH}`;
const MAX_CLEANUP_OBJECT_IDS = 100;
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/i;

type AdminCleanupResult = TraceCleanupResult | Readonly<{ kind: "failed" }>;

export async function handleTraceAggregateCleanup(
  request: Request,
  env: OtelEnv,
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== TRACE_AGGREGATE_CLEANUP_PATH) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const adminToken = env.OTEL_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization");
  if (
    !adminToken ||
    !authorization?.startsWith("Bearer ") ||
    !(await timingSafeSecretEqual(authorization.slice("Bearer ".length), adminToken))
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const objectIds = readObjectIds(body);
  if (!objectIds) return Response.json({ error: "invalid_object_ids" }, { status: 400 });

  const results = await Promise.all(
    objectIds.map(
      async (
        objectId,
      ): Promise<Readonly<{ objectId: string; kind: AdminCleanupResult["kind"] }>> => {
        try {
          const durableObjectId = env.OTEL_TRACE_AGGREGATE.idFromString(objectId);
          const response = await env.OTEL_TRACE_AGGREGATE.get(durableObjectId).fetch(
            TRACE_AGGREGATE_INTERNAL_CLEANUP_URL,
            { method: "POST" },
          );
          if (!response.ok) return { objectId, kind: "failed" };
          const result = readCleanupResult(await response.json());
          return result ? { objectId, kind: result.kind } : { objectId, kind: "failed" };
        } catch {
          return { objectId, kind: "failed" };
        }
      },
    ),
  );
  return Response.json({ results });
}

function readObjectIds(value: unknown): readonly string[] | null {
  if (!isRecord(value) || !Array.isArray(value["objectIds"])) return null;
  const objectIds: string[] = [];
  for (const objectId of value["objectIds"]) {
    if (typeof objectId !== "string" || !OBJECT_ID_PATTERN.test(objectId)) return null;
    objectIds.push(objectId);
  }
  if (objectIds.length > MAX_CLEANUP_OBJECT_IDS) return null;
  return objectIds;
}

function readCleanupResult(value: unknown): TraceCleanupResult | null {
  if (!isRecord(value)) return null;
  const kind = value["kind"];
  if (kind === "deleted" || kind === "active" || kind === "empty") return { kind };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
