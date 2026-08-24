import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc } from "../../scripts/parse-jsonc.mjs";
import { validateOtelWorkerConfig } from "../../scripts/verify-otel-worker-config.mjs";

const root = resolve(import.meta.dirname, "../..");
const config = parseJsonc(readFileSync(resolve(root, "workers/wrangler.otel.jsonc"), "utf8"));

test("dedicated OTel Worker owns its isolated runtime contract", () => {
  assert.equal(config.name, "graft-ai-aig-otel");
  assert.equal(config.main, "src/otel.ts");
  assert.equal(config.workers_dev, true);
  assert.equal(config.queues.producers.length, 8);
  assert.equal(config.queues.consumers.length, 4);
  assert.ok(config.queues.consumers.every((consumer) => consumer.max_retries === 7));
  assert.equal(config.kv_namespaces[0].binding, "OTEL_PAYLOAD_KV");
  assert.deepEqual(Object.keys(config.exports).sort(), [
    "OtelLedger",
    "OtelMetricsAggregate",
    "OtelRateLimit",
    "TraceAggregate",
  ]);
  assert.doesNotMatch(
    JSON.stringify(config),
    /"(?:authorization|OTEL_INGEST_TOKEN|OTEL_RATE_LIMIT_HMAC_KEY)"\s*:/i,
  );
});

test("rejects quoted inline secret keys and mismatched DLQs", () => {
  const serialized = JSON.stringify(config);
  assert.throws(
    () => validateOtelWorkerConfig(config, `${serialized}\n"OTEL_INGEST_TOKEN": "inline"`),
    /inline credential/,
  );

  const invalid = structuredClone(config);
  invalid.queues.consumers[0].dead_letter_queue = "wrong-dlq";
  assert.throws(() => validateOtelWorkerConfig(invalid, serialized), /consumer contract/);
});

test("rejects any explicit initial Worker route", () => {
  const serialized = JSON.stringify(config);
  const invalidConfigs = [
    { ...config, route: "https://otel.example.com/*" },
    { ...config, routes: ["graft-ai.workers.dev/*"] },
    { ...config, routes: [{ pattern: "otel.example.com/*" }] },
  ];

  for (const invalid of invalidConfigs) {
    assert.throws(
      () => validateOtelWorkerConfig(invalid, serialized),
      /initial OTel Worker routes must remain on workers\.dev/,
    );
  }

  assert.doesNotThrow(() => validateOtelWorkerConfig(config, serialized));
  assert.doesNotThrow(() => validateOtelWorkerConfig({ ...config, routes: [] }, serialized));
});

test("requires rate limiting before the ingress body is consumed", () => {
  const ingressSource = readFileSync(resolve(root, "workers/src/otel/ingress.ts"), "utf8");
  const bodyRead = ingressSource.indexOf("const body = await readBody(request)");
  const rateLimitCheck = ingressSource.indexOf("const rateLimit = await rateLimitTake");

  assert.notEqual(bodyRead, -1);
  assert.notEqual(rateLimitCheck, -1);
  assert.ok(rateLimitCheck < bodyRead);
});
