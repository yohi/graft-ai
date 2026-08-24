import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc } from "../../scripts/parse-jsonc.mjs";
import { renderOtelWorkerConfig } from "../../scripts/render-otel-worker-config.mjs";
import { validateOtelWorkerConfig } from "../../scripts/verify-otel-worker-config.mjs";

const root = resolve(import.meta.dirname, "../..");
const config = parseJsonc(readFileSync(resolve(root, "workers/wrangler.otel.jsonc"), "utf8"));

test("dedicated OTel Worker owns its isolated runtime contract", () => {
  assert.equal(config.name, "graft-ai-aig-otel");
  assert.equal(config.main, "src/otel.ts");
  assert.equal(config.workers_dev, true);
  assert.equal(config.queues.producers.length, 8);
  assert.equal(config.queues.consumers.length, 4);
  assert.equal(config.vars.OTEL_PAYLOAD_STORE, "kv");
  assert.deepEqual(config.kv_namespaces, [
    { binding: "OTEL_PAYLOAD_KV", id: "__OTEL_PAYLOAD_KV_NAMESPACE_ID__" },
  ]);
  assert.equal(config.r2_buckets, undefined);
  assert.ok(config.queues.producers.some((entry) => entry.binding === "OTEL_INGRESS_DLQ"));
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

test("renders KV-default, R2, and KV/R2-drain binding contracts", () => {
  const options = {
    kvNamespaceId: "00000000000000000000000000000000",
  };
  const kv = renderOtelWorkerConfig(config, {
    ...options,
    payloadStore: "kv",
    includeR2Binding: false,
  });
  assert.equal(kv.vars.OTEL_PAYLOAD_STORE, "kv");
  assert.deepEqual(kv.kv_namespaces, [
    { binding: "OTEL_PAYLOAD_KV", id: options.kvNamespaceId },
  ]);
  assert.equal(kv.r2_buckets, undefined);
  assert.doesNotThrow(() =>
    validateOtelWorkerConfig(kv, JSON.stringify(kv), {
      payloadStore: "kv",
      includeR2Binding: false,
    }),
  );

  const r2 = renderOtelWorkerConfig(config, {
    ...options,
    payloadStore: "r2",
    includeR2Binding: true,
  });
  assert.equal(r2.vars.OTEL_PAYLOAD_STORE, "r2");
  assert.deepEqual(r2.r2_buckets, [
    { binding: "OTEL_OBJECTS", bucket_name: "graft-ai-aig-otel-v1" },
  ]);
  assert.doesNotThrow(() =>
    validateOtelWorkerConfig(r2, JSON.stringify(r2), {
      payloadStore: "r2",
      includeR2Binding: true,
    }),
  );

  const drain = renderOtelWorkerConfig(config, {
    ...options,
    payloadStore: "kv",
    includeR2Binding: true,
  });
  assert.equal(drain.vars.OTEL_PAYLOAD_STORE, "kv");
  assert.deepEqual(drain.r2_buckets, r2.r2_buckets);
  assert.doesNotThrow(() =>
    validateOtelWorkerConfig(drain, JSON.stringify(drain), {
      payloadStore: "kv",
      includeR2Binding: true,
    }),
  );
});

test("rejects invalid selector, namespace ID, and unsafe binding combinations", () => {
  const valid = {
    kvNamespaceId: "00000000000000000000000000000000",
    payloadStore: "kv",
    includeR2Binding: false,
  };
  assert.throws(
    () => renderOtelWorkerConfig(config, { ...valid, payloadStore: "d1" }),
    /payloadStore/,
  );
  assert.throws(
    () => renderOtelWorkerConfig(config, { ...valid, kvNamespaceId: "short" }),
    /namespace ID/,
  );
  assert.throws(
    () => renderOtelWorkerConfig(config, { ...valid, kvNamespaceId: undefined }),
    /namespace ID/,
  );
  assert.throws(
    () => renderOtelWorkerConfig(config, { ...valid, payloadStore: "r2" }),
    /R2 binding/,
  );
  assert.throws(
    () => validateOtelWorkerConfig({ ...config, r2_buckets: [{ binding: "OTEL_OBJECTS" }] }, JSON.stringify(config), {
      payloadStore: "kv",
      includeR2Binding: false,
    }),
    /R2 binding/,
  );
  assert.throws(
    () => validateOtelWorkerConfig(
      { ...config, vars: { ...config.vars, OTEL_PAYLOAD_STORE: "r2" } },
      JSON.stringify(config),
      { payloadStore: "kv", includeR2Binding: false },
    ),
    /selector/,
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
