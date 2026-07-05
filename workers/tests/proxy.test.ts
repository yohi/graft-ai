import { describe, expect, it, vi } from "vitest";
import proxyWorker from "../src/proxy";
import type { Env, TelemetryEvent } from "../src/types";

const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    GRAFANA_CLOUD_LOKI_URL: "https://logs-prod-xxx.grafana.net",
    GRAFANA_CLOUD_LOKI_USERNAME: "123456",
    GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "glc_testtoken",
    ORIGIN_SECRET: "test-origin-secret",
    RSA_PRIVATE_KEY_PEM: "unused-in-proxy-mode",
    GATEWAY_NAME: "main",
    ENV_LABEL: "prod",
    CF_ACCOUNT_ID: "account-123",
    AI_GATEWAY_ID: "gateway-main",
    ...overrides,
  };
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe("AI Gateway proxy Worker", () => {
  it("forwards method, body, headers, and path to Cloudflare AI Gateway", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "cf-aig-request-id": "req-from-aig",
          "cf-aig-model": "@cf/meta/llama-3.1-8b-instruct",
        },
      });
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const request = new Request("https://proxy.example.com/v1/chat/completions?debug=true", {
      method: "POST",
      headers: {
        authorization: "Bearer user-token",
        "content-type": "application/json",
        "x-client-trace": "trace-1",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    const response = await proxyWorker.fetch?.(
      request,
      buildEnv(),
      mockCtx as unknown as ExecutionContext,
    );

    expect(response?.status).toBe(201);
    expect(await response?.text()).toBe('{"ok":true}');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls).toHaveLength(1);
    const [input, init] = fetchSpy.mock.calls[0] ?? [];
    if (input === undefined) {
      throw new Error("expected upstream fetch input");
    }
    expect(fetchInputUrl(input)).toBe(
      "https://gateway.ai.cloudflare.com/v1/account-123/gateway-main/v1/chat/completions?debug=true",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeDefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer user-token");
    expect(headers.get("x-client-trace")).toBe("trace-1");

    vi.restoreAllMocks();
  });

  it("emits one marked telemetry JSON line with response header fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "cf-aig-request-id": "req-telemetry",
          "cf-aig-model": "gpt-4o-mini",
          "cf-aig-cache-status": "hit",
          "cf-aig-tokens": "prompt=12,completion=7,total=19",
          "cf-aig-duration-ms": "345",
        },
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const request = new Request("https://proxy.example.com/openai/v1/responses", { method: "GET" });
    const response = await proxyWorker.fetch?.(
      request,
      buildEnv(),
      mockCtx as unknown as ExecutionContext,
    );

    expect(response?.status).toBe(200);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [line] = logSpy.mock.calls[0] ?? [];
    expect(typeof line).toBe("string");
    const telemetry = JSON.parse(line) as TelemetryEvent;
    expect(telemetry._graft_ai_telemetry).toBe(true);
    expect(telemetry.request_id).toBe("req-telemetry");
    expect(telemetry.model).toBe("gpt-4o-mini");
    expect(telemetry.status_code).toBe(200);
    expect(telemetry.cache_status).toBe("hit");
    expect(telemetry.prompt_tokens).toBe(12);
    expect(telemetry.completion_tokens).toBe(7);
    expect(telemetry.total_tokens).toBe(19);
    expect(telemetry.duration_ms).toBe(345);
    expect(telemetry.path).toBe("/openai/v1/responses");
    expect(telemetry.method).toBe("GET");
    expect(telemetry.gateway).toBe("main");
    expect(telemetry.env).toBe("prod");
    expect(Date.parse(telemetry.timestamp)).not.toBeNaN();

    vi.restoreAllMocks();
  });
});
