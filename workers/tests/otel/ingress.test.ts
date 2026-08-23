import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleIngress } from "../../src/otel";
import type { OtelEnv } from "../../src/otel/types";
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
    const response = await handleIngress(request(validOtlpJson), otelEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reason: "accepted" });

    const listed = await otelEnv.OTEL_OBJECTS.list({ prefix: "otel/ingress/" });
    expect(listed.objects.length).toBeGreaterThan(0);
    const object = await otelEnv.OTEL_OBJECTS.get(
      listed.objects[listed.objects.length - 1]?.key ?? "",
    );
    const text = await object?.text();
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sk-live-test-secret");
  });
});
