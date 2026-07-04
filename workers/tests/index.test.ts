import { describe, it, expect, vi } from "vitest";
import handler from "../src/index";
import type { Env, EncryptedField } from "../src/types";

// Helper to generate a test RSA key pair and return PEM strings
async function getTestPrivateKeyPem(): Promise<string> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
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

// Generate a test RSA key pair inside the Workers runtime
async function generateTestKeyPair(): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;

  const privateKeyDer = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
  const publicKeyDer = (await crypto.subtle.exportKey("spki", keyPair.publicKey)) as ArrayBuffer;

  const privateKeyPem = pemEncode(privateKeyDer, "PRIVATE KEY");
  const publicKeyPem = pemEncode(publicKeyDer, "PUBLIC KEY");

  return { privateKeyPem, publicKeyPem };
}

function pemEncode(der: ArrayBuffer, type: string): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [base64];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}

// Encrypt a string using hybrid encryption (RSA-OAEP + AES-GCM) matching Cloudflare's scheme
async function encryptForTest(publicKeyPem: string, plaintext: string): Promise<EncryptedField> {
  const pubKey = await crypto.subtle.importKey(
    "spki",
    derFromPem(publicKeyPem, "PUBLIC KEY"),
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"],
  );

  const aesKey = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoder.encode(plaintext),
  );

  const aesKeyRaw = (await crypto.subtle.exportKey("raw", aesKey)) as ArrayBuffer;
  const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKey, aesKeyRaw);

  return {
    key: base64Encode(wrappedKey),
    iv: base64Encode(iv.buffer),
    data: base64Encode(ciphertext),
  };
}

function derFromPem(pem: string, type: string): ArrayBuffer {
  const header = `-----BEGIN ${type}-----`;
  const footer = `-----END ${type}-----`;
  const b64 = pem.substring(header.length, pem.length - footer.length).replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64Encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe("Worker fetch handler", () => {
  it("returns 405 for GET requests", async () => {
    const env = buildEnv();
    const request = new Request("https://worker.example.com/", {
      method: "GET",
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(405);
  });

  it("returns 200 on valid POST with unencrypted logs", async () => {
    const env = buildEnv({ RSA_PRIVATE_KEY_PEM: await getTestPrivateKeyPem() });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      const url = fetchInputUrl(input);
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
      },
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(200);

    vi.restoreAllMocks();
  });

  it("returns 503 when Loki push fails with 500", async () => {
    const env = buildEnv({ RSA_PRIVATE_KEY_PEM: await getTestPrivateKeyPem() });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      const url = fetchInputUrl(input);
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
      },
    });
    const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
    expect(response.status).toBe(400);
  });
});

it("includes decrypted bodies in Loki payload when env flags are enabled", async () => {
  const { privateKeyPem, publicKeyPem } = await generateTestKeyPair();
  const env = buildEnv({
    RSA_PRIVATE_KEY_PEM: privateKeyPem,
    INCLUDE_REQUEST_BODY: "true",
    INCLUDE_RESPONSE_BODY: "true",
    INCLUDE_METADATA: "true",
  });

  const metadata = await encryptForTest(publicKeyPem, JSON.stringify({ model: "gpt-4o" }));
  const requestBody = await encryptForTest(publicKeyPem, JSON.stringify({ messages: [] }));
  const responseBody = await encryptForTest(publicKeyPem, JSON.stringify({ choices: [] }));

  const ndjson = JSON.stringify({
    RequestID: "req-encrypted",
    RequestTime: 1720032000,
    CacheStatus: "miss",
    StatusCode: 200,
    Model: "gpt-4o",
    PromptTokens: 10,
    CompletionTokens: 5,
    TotalTokens: 15,
    RequestDuration: 100,
    Path: "/v1/chat/completions",
    Method: "POST",
    Metadata: metadata,
    RequestBody: requestBody,
    ResponseBody: responseBody,
  });

  let pushedBody: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = fetchInputUrl(input);
        if (url.includes("/loki/api/v1/push")) {
        pushedBody = init?.body as string;
      return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
      },
    );

  const request = new Request("https://worker.example.com/", {
    method: "POST",
      body: await gzipText(ndjson),
      headers: {
        "Content-Encoding": "gzip",
      },
  });
  const response = await handler.fetch!(request, env, mockCtx as unknown as ExecutionContext);
  expect(response.status).toBe(200);
  expect(pushedBody).not.toBeNull();
  const payload = JSON.parse(pushedBody!);
  const logLine = JSON.parse(payload.streams[0].values[0][1]);
  expect(logLine.metadata).toEqual({ model: "gpt-4o" });
  expect(logLine.request_body).toEqual({ messages: [] });
  expect(logLine.response_body).toEqual({ choices: [] });

  vi.restoreAllMocks();
});
