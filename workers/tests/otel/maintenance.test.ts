import { describe, expect, it } from "vitest";
import { handleTraceAggregateCleanup } from "../../src/otel/maintenance";
import { TRACE_AGGREGATE_INTERNAL_CLEANUP_PATH } from "../../src/otel/trace-aggregate";
import type { OtelEnv } from "../../src/otel/types";

const cleanupPath = "https://otel/_admin/trace-aggregate/cleanup";

describe("TraceAggregate maintenance", () => {
  it("cleans the requested object IDs with the admin token", async () => {
    const objectId = "a".repeat(64);
    const { requestedIds, requestedUrls, testEnv } = createCleanupEnv();

    const response = await handleTraceAggregateCleanup(
      new Request(cleanupPath, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ objectIds: [objectId] }),
      }),
      testEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [{ objectId, kind: "deleted" }],
    });
    expect(requestedIds).toEqual([objectId]);
    expect(requestedUrls).toEqual([`https://trace${TRACE_AGGREGATE_INTERNAL_CLEANUP_PATH}`]);
  });

  it("rejects a request with an invalid admin token", async () => {
    const { requestedIds, testEnv } = createCleanupEnv();

    const response = await handleTraceAggregateCleanup(
      new Request(cleanupPath, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
        body: JSON.stringify({ objectIds: ["a".repeat(64)] }),
      }),
      testEnv,
    );

    expect(response.status).toBe(401);
    expect(requestedIds).toHaveLength(0);
  });

  it("returns 400 when reading the JSON body fails", async () => {
    const { testEnv } = createCleanupEnv();
    const request = {
      method: "POST",
      url: cleanupPath,
      headers: new Headers({ authorization: "Bearer admin-token" }),
      json: async (): Promise<unknown> => {
        throw new TypeError("request stream failed");
      },
    } as unknown as Request;

    const response = await handleTraceAggregateCleanup(request, testEnv);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json" });
  });

  it("returns failed for cleanup operations that throw non-Error values", async () => {
    const failedObjectId = "b".repeat(64);
    const successfulObjectId = "c".repeat(64);
    const testEnv = {
      OTEL_ADMIN_TOKEN: "admin-token",
      OTEL_TRACE_AGGREGATE: {
        idFromString: (id: string): string => id,
        get: (id: string) => ({
          fetch: async (): Promise<Response> => {
            if (id === failedObjectId) throw null;
            return Response.json({ kind: "deleted" });
          },
        }),
      },
    } as unknown as OtelEnv;

    const response = await handleTraceAggregateCleanup(
      new Request(cleanupPath, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ objectIds: [failedObjectId, successfulObjectId] }),
      }),
      testEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        { objectId: failedObjectId, kind: "failed" },
        { objectId: successfulObjectId, kind: "deleted" },
      ],
    });
  });
});

function createCleanupEnv(): Readonly<{
  requestedIds: string[];
  requestedUrls: string[];
  testEnv: OtelEnv;
}> {
  const requestedIds: string[] = [];
  const requestedUrls: string[] = [];
  const namespace = {
    idFromString: (id: string): string => id,
    get: (id: string) => ({
      fetch: async (input: string): Promise<Response> => {
        requestedIds.push(id);
        requestedUrls.push(input);
        return Response.json({ kind: "deleted" });
      },
    }),
  };
  const testEnv = {
    OTEL_ADMIN_TOKEN: "admin-token",
    OTEL_TRACE_AGGREGATE: namespace,
  } as unknown as OtelEnv;
  return { requestedIds, requestedUrls, testEnv };
}
