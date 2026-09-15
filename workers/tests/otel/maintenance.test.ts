import { describe, expect, it } from "vitest";
import { handleTraceAggregateCleanup } from "../../src/otel/maintenance";
import type { OtelEnv } from "../../src/otel/types";

const cleanupPath = "https://otel/_admin/trace-aggregate/cleanup";

describe("TraceAggregate maintenance", () => {
  it("cleans the requested object IDs with the admin token", async () => {
    const objectId = "a".repeat(64);
    const { requestedIds, testEnv } = createCleanupEnv();

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
});

function createCleanupEnv(): Readonly<{ requestedIds: string[]; testEnv: OtelEnv }> {
  const requestedIds: string[] = [];
  const namespace = {
    idFromString: (id: string): string => id,
    get: (id: string) => ({
      fetch: async (): Promise<Response> => {
        requestedIds.push(id);
        return Response.json({ kind: "deleted" });
      },
    }),
  };
  const testEnv = {
    OTEL_ADMIN_TOKEN: "admin-token",
    OTEL_TRACE_AGGREGATE: namespace,
  } as unknown as OtelEnv;
  return { requestedIds, testEnv };
}
