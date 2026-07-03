import { describe, it, expect, vi } from "vitest";
import handler from "../src/index";
import type { Env } from "../src/types";

// Helper to generate a test RSA key pair and return PEM strings
async function getTestPrivateKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [base64];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    GRAFANA_CLOUD_LOKI_URL: "https://logs-prod-xxx.grafana.net",
    GRAFANA_CLOUD_LOKI_USERNAME: "123456",
    GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "glc_testtoken",
    ORIGIN_SECRET: "test-origin-secret",
    RSA_PRIVATE_KEY_PEM: "",
    GATEWAY_NAME: "main",
    ENV_LABEL: "prod",
    ...overrides,
  };
}

const sampleNdjson = [
  JSON.stringify({
    RequestID: "req-001",
    RequestTime: 1720032000,
    CacheStatus: "miss",
    StatusCode: 200,
    Model: "@cf/meta/llama-3.1-8b-instruct",
    PromptTokens: 150,
    CompletionTokens: 80,
    TotalTokens: 230,
    RequestDuration: 1250,
    Path: "/v1/chat/completions",
    Method: "POST",
  }),
].join("\n");

async function gzipText(text: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  const compressed = stream.pipeThrough(new CompressionStream("gzip"));
  return new Response(compressed).arrayBuffer();
}

const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

describe("Worker fetch handler", () => {
  it("returns 401 when X-Origin-Secret header is missing", async () => {
    const env = buildEnv({ RSA_PRIVATE_KEY_PEM: await getTestPrivateKeyPem() });
    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: await gzipText(sampleNdjson),
      headers: { "Content-Encoding": "gzip" },
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(401);
  });

  it("returns 401 when X-Origin-Secret header is wrong", async () => {
    const env = buildEnv({ RSA_PRIVATE_KEY_PEM: await getTestPrivateKeyPem() });
    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: await gzipText(sampleNdjson),
      headers: { "Content-Encoding": "gzip", "X-Origin-Secret": "wrong-secret" },
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(401);
  });

  it("returns 405 for GET requests", async () => {
    const env = buildEnv();
    const request = new Request("https://worker.example.com/", {
      method: "GET",
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(405);
  });

  it("returns 200 on valid POST with correct origin secret and unencrypted logs", async () => {
    const env = buildEnv({ RSA_PRIVATE_KEY_PEM: await getTestPrivateKeyPem() });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/loki/api/v1/push")) {
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: await gzipText(sampleNdjson),
      headers: {
        "Content-Encoding": "gzip",
        "X-Origin-Secret": "test-origin-secret",
      },
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(200);

    vi.restoreAllMocks();
  });

  it("returns 503 when Loki push fails with 500", async () => {
    const env = buildEnv({ RSA_PRIVATE_KEY_PEM: await getTestPrivateKeyPem() });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/loki/api/v1/push")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: await gzipText(sampleNdjson),
      headers: {
        "Content-Encoding": "gzip",
        "X-Origin-Secret": "test-origin-secret",
      },
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(503);

    vi.restoreAllMocks();
  });

  it("returns 400 for a malformed gzip body (stops Logpush retry)", async () => {
    const env = buildEnv({ RSA_PRIVATE_KEY_PEM: await getTestPrivateKeyPem() });

    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]),
      headers: {
        "Content-Encoding": "gzip",
        "X-Origin-Secret": "test-origin-secret",
      },
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(400);
  });

  it("returns 400 when the gzip body is missing", async () => {
    const env = buildEnv({ RSA_PRIVATE_KEY_PEM: await getTestPrivateKeyPem() });

    const request = new Request("https://worker.example.com/", {
      method: "POST",
      headers: {
        "Content-Encoding": "gzip",
        "X-Origin-Secret": "test-origin-secret",
      },
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(400);
  });

  it("returns 400 when all log lines fail to parse (stops Logpush retry)", async () => {
    const env = buildEnv({ RSA_PRIVATE_KEY_PEM: await getTestPrivateKeyPem() });

    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: await gzipText("not-json\n{invalid\n"),
      headers: {
        "Content-Encoding": "gzip",
        "X-Origin-Secret": "test-origin-secret",
      },
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(400);
  });
});
