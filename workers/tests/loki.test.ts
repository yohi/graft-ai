import { describe, it, expect, vi } from "vitest";
import { pushToLoki } from "../src/loki";
import type { LokiPushPayload } from "../src/types";

const testPayload: LokiPushPayload = {
  streams: [
    {
      stream: { model: "llama-3.1-8b", status_code: "200", env: "prod", gateway: "main" },
      values: [["1720032000000000000", '{"request_id":"abc123"}']],
    },
  ],
};

const testEnv = {
  GRAFANA_CLOUD_LOKI_URL: "https://logs-prod-xxx.grafana.net",
  GRAFANA_CLOUD_LOKI_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "glc_testtoken",
};

describe("pushToLoki", () => {
  it("returns ok on HTTP 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns ok on HTTP 204", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
  });

  it("returns not-ok on HTTP 400 without retry", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Bad Request", { status: 400 }));
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on HTTP 429 up to 3 times then returns not-ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Too Many Requests", { status: 429 }));
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("succeeds on retry after initial 429", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on HTTP 500", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends Basic Auth header with username:token", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushToLoki(testEnv, testPayload, mockFetch);
    const call = mockFetch.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toBe("https://logs-prod-xxx.grafana.net/loki/api/v1/push");
    const authHeader = (init.headers as Record<string, string>)["Authorization"];
    expect(authHeader).toBeDefined();
    const expectedBasic = btoa("123456:glc_testtoken");
    expect(authHeader).toBe(`Basic ${expectedBasic}`);
  });

  it("sends Content-Type application/json", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushToLoki(testEnv, testPayload, mockFetch);
    const call = mockFetch.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends payload as JSON body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushToLoki(testEnv, testPayload, mockFetch);
    const call = mockFetch.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify(testPayload));
  });
});
