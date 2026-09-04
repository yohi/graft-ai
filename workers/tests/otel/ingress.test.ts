import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { handleIngress } from "../../src/otel";
import { payloadStoreForPointer } from "../../src/otel/storage";
import type { IngressPointer, OtelEnv } from "../../src/otel/types";
import { validOtlpJson } from "./fixtures";

const otelEnv = {
  ...(env as unknown as OtelEnv),
  OTEL_INGEST_TOKEN: "test-token",
  OTEL_RATE_LIMIT_HMAC_KEY: "test-rate-key",
  OTEL_SAMPLING_RATE: "1",
} as OtelEnv;

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://worker.example/v1/traces", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("OTel ingress", () => {
  it("uses KV and delays the first ingress delivery when the selector is kv", async () => {
    const sent: Array<Readonly<{ pointer: IngressPointer; options?: QueueSendOptions }>> = [];
    const queue = {
      send: vi.fn(async (pointer: IngressPointer, options?: QueueSendOptions) => {
        sent.push({ pointer, ...(options ? { options } : {}) });
      }),
    } as unknown as Queue<IngressPointer>;
    const testEnv = {
      ...otelEnv,
      OTEL_PAYLOAD_STORE: "kv",
      OTEL_INGRESS_QUEUE: queue,
    } as OtelEnv;
    const body = structuredClone(validOtlpJson) as typeof validOtlpJson;
    const firstResource = body.resourceSpans[0]?.resource;
    if (!firstResource) throw new Error("fixture resource missing");
    firstResource.attributes = [
      ...(firstResource.attributes ?? []),
      { key: "test.kv-default", value: { stringValue: crypto.randomUUID() } },
    ];

    const response = await handleIngress(request(body), testEnv);

    expect(response.status).toBe(200);
    const delivery = sent[0];
    if (!delivery || delivery.pointer.schemaVersion !== 2) {
      throw new Error("ingress pointer is not current");
    }
    expect(delivery?.pointer.storageBackend).toBe("kv");
    expect(delivery?.options).toEqual({ delaySeconds: 60 });
  });

  it("returns the documented rejection statuses before persistence", async () => {
    await expect(
      handleIngress(new Request("https://worker.example/v1/metrics"), otelEnv),
    ).resolves.toHaveProperty("status", 404);
    await expect(
      handleIngress(request(validOtlpJson, { authorization: "Bearer wrong" }), otelEnv),
    ).resolves.toHaveProperty("status", 401);
    await expect(
      handleIngress(request(validOtlpJson, { "content-type": "application/x-protobuf" }), otelEnv),
    ).resolves.toHaveProperty("status", 415);
  });

  it("persists only a redacted envelope and returns an accepted response", async () => {
    const sent: IngressPointer[] = [];
    const queue = {
      send: vi.fn(async (pointer: IngressPointer) => {
        sent.push(pointer);
      }),
    } as unknown as Queue<IngressPointer>;
    const testEnv = { ...otelEnv, OTEL_INGRESS_QUEUE: queue } as OtelEnv;
    const body = structuredClone(validOtlpJson) as typeof validOtlpJson;
    const firstResource = body.resourceSpans[0]?.resource;
    if (!firstResource) throw new Error("fixture resource missing");
    firstResource.attributes = [
      ...(firstResource.attributes ?? []),
      { key: "test.redacted-envelope", value: { stringValue: crypto.randomUUID() } },
    ];

    const response = await handleIngress(request(body), testEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reason: "accepted" });

    const pointer = sent.at(-1);
    if (!pointer) throw new Error("ingress pointer was not queued");
    if (pointer.schemaVersion !== 2) throw new Error("ingress pointer is not current");
    const bytes = await payloadStoreForPointer(testEnv, pointer).readBytesObject(pointer);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sk-live-test-secret");
  });

  it("serializes the redacted envelope once before persistence", async () => {
    const queue = { send: vi.fn(async () => undefined) } as unknown as Queue<IngressPointer>;
    const testEnv = { ...otelEnv, OTEL_INGRESS_QUEUE: queue } as OtelEnv;
    const stringify = vi.spyOn(JSON, "stringify");

    try {
      const response = await handleIngress(request(validOtlpJson), testEnv);

      expect(response.status).toBe(200);
      const envelopeSerializations = stringify.mock.calls.filter(([value]) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        return "schemaVersion" in value && "spans" in value;
      });
      expect(envelopeSerializations).toHaveLength(1);
    } finally {
      stringify.mockRestore();
    }
  });

  it.skipIf(!otelEnv.OTEL_PAYLOAD_D1)(
    "returns 413 when the redacted envelope exceeds the D1 row limit",
    async () => {
      const queue = { send: vi.fn(async () => undefined) } as unknown as Queue<IngressPointer>;
      const testEnv = {
        ...otelEnv,
        OTEL_PAYLOAD_STORE: "d1",
        OTEL_INGRESS_QUEUE: queue,
      } as OtelEnv;
      const response = await handleIngress(
        request(bodyWithPrompt(JSON.stringify("x".repeat(1_900_000))), {}),
        testEnv,
      );

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "payload_too_large" });
      expect(queue.send).not.toHaveBeenCalled();
    },
  );

  it("uses matching ingress IDs and payload hashes for reordered JSON payload keys", async () => {
    const reservations: Array<{ ingressId: string; payloadSha256: string }> = [];
    const ledgerTarget = otelEnv.OTEL_LEDGER.getByName(`canonical-${crypto.randomUUID()}`);
    const ledgerStub = {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = (await request.clone().json()) as {
          operation?: string;
          ingressId?: string;
          payloadSha256?: string;
        };
        if (
          body.operation === "ingress.reserve" &&
          typeof body.ingressId === "string" &&
          typeof body.payloadSha256 === "string"
        ) {
          reservations.push({ ingressId: body.ingressId, payloadSha256: body.payloadSha256 });
        }
        return ledgerTarget.fetch(request);
      },
    } as unknown as DurableObjectStub;
    const send = vi.fn(async (_pointer: IngressPointer) => undefined);
    const testEnv = {
      ...otelEnv,
      OTEL_LEDGER: { getByName: () => ledgerStub } as unknown as DurableObjectNamespace,
      OTEL_INGRESS_QUEUE: { send } as unknown as Queue<IngressPointer>,
    } as OtelEnv;

    const first = await handleIngress(
      request(bodyWithPrompt('{"outer":{"z":1,"nested":{"d":4,"c":3}},"items":[{"b":2,"a":1}]}')),
      testEnv,
    );
    const second = await handleIngress(
      request(bodyWithPrompt('{"items":[{"a":1,"b":2}],"outer":{"nested":{"c":3,"d":4},"z":1}}')),
      testEnv,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(reservations).toHaveLength(2);
    expect(reservations[1]).toEqual(reservations[0]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries a durable ready reservation after the first queue send fails", async () => {
    const queue = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error("queue unavailable"))
        .mockResolvedValue(undefined),
    } as unknown as Queue<unknown>;
    const testEnv = { ...otelEnv, OTEL_INGRESS_QUEUE: queue } as OtelEnv;
    const body = structuredClone(validOtlpJson) as typeof validOtlpJson;
    const firstResource = body.resourceSpans[0]?.resource;
    if (!firstResource) throw new Error("fixture resource missing");
    firstResource.attributes = [
      ...(firstResource.attributes ?? []),
      { key: "test.recovery", value: { stringValue: crypto.randomUUID() } },
    ];
    const first = await handleIngress(request(body), testEnv);
    expect(first.status).toBe(503);

    const second = await handleIngress(request(body), testEnv);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ reason: "accepted" });
    expect(queue.send).toHaveBeenCalledTimes(2);
  });

  it("rate-limits from request headers before consuming the request body", async () => {
    const rateLimitStub = otelEnv.OTEL_RATE_LIMIT.getByName(`rate-test-${crypto.randomUUID()}`);
    const rateLimitFetch = vi
      .spyOn(rateLimitStub, "fetch")
      .mockResolvedValue(Response.json({ allowed: false, retryAfterSeconds: 1 }));
    const getRateLimitStub = vi
      .spyOn(otelEnv.OTEL_RATE_LIMIT, "getByName")
      .mockReturnValue(rateLimitStub);
    let bodyRead = false;
    const body = {
      getReader() {
        bodyRead = true;
        throw new Error("request body must not be consumed");
      },
    };
    const request = new Proxy(
      new Request("https://worker.example/v1/traces", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.12",
        },
        body: "{}",
      }),
      {
        get(target, property) {
          if (property === "body") return body;
          return Reflect.get(target, property, target);
        },
      },
    );

    try {
      const response = await handleIngress(request, otelEnv);

      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: "rate_limited" });
      expect(bodyRead).toBe(false);
    } finally {
      getRateLimitStub.mockRestore();
      rateLimitFetch.mockRestore();
    }
  });
});

function bodyWithPrompt(prompt: string): typeof validOtlpJson {
  const body = structuredClone(validOtlpJson) as typeof validOtlpJson;
  const attributes = body.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes;
  if (!attributes) throw new Error("fixture span attributes missing");
  const promptAttribute = attributes.find((attribute) => attribute.key === "gen_ai.prompt_json");
  if (!promptAttribute) throw new Error("fixture prompt attribute missing");
  promptAttribute.value = { stringValue: prompt };
  return body;
}
