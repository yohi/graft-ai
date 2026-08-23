import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc } from "../../scripts/parse-jsonc.mjs";

const root = resolve(import.meta.dirname, "../..");
const config = parseJsonc(
  readFileSync(resolve(root, "workers/wrangler.otel.jsonc"), "utf8"),
);

test("dedicated OTel Worker owns its isolated runtime contract", () => {
  assert.equal(config.name, "graft-ai-aig-otel");
  assert.equal(config.main, "src/otel.ts");
  assert.equal(config.workers_dev, true);
  assert.equal(config.queues.producers.length, 4);
  assert.equal(config.queues.consumers.length, 4);
  assert.equal(config.r2_buckets[0].binding, "OTEL_OBJECTS");
  assert.deepEqual(Object.keys(config.exports).sort(), [
    "OtelLedger",
    "OtelMetricsAggregate",
    "OtelRateLimit",
    "TraceAggregate",
  ]);
  assert.doesNotMatch(
    JSON.stringify(config),
    /Authorization:|OTEL_INGEST_TOKEN\s*:/,
  );
});
