import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseJsonc } from "./parse-jsonc.mjs";

const expectedQueues = {
  OTEL_INGRESS_QUEUE: "graft-ai-aig-otel-ingress-v1",
  OTEL_TEMPO_QUEUE: "graft-ai-aig-otel-tempo-v1",
  OTEL_LOKI_QUEUE: "graft-ai-aig-otel-loki-v1",
  OTEL_PROMETHEUS_QUEUE: "graft-ai-aig-otel-prometheus-v1",
};

const expectedConsumers = [
  "graft-ai-aig-otel-ingress-v1",
  "graft-ai-aig-otel-tempo-v1",
  "graft-ai-aig-otel-loki-v1",
  "graft-ai-aig-otel-prometheus-v1",
];

export function validateOtelWorkerConfig(config, rawConfig) {
  if (config.name !== "graft-ai-aig-otel") throw new Error("unexpected OTel Worker name");
  if (config.main !== "src/otel.ts") throw new Error("OTel Worker must use src/otel.ts");
  if (config.workers_dev !== true) throw new Error("OTel Worker must keep workers_dev enabled");
  if (config.migrations !== undefined) throw new Error("legacy migrations are forbidden for SQLite Durable Objects");
  if (/protobuf/i.test(rawConfig)) throw new Error("OTel Worker configuration must be JSON-only");
  if (/["']?(?:authorization|otel_ingest_token|otel_rate_limit_hmac_key)["']?\s*:/i.test(rawConfig)) {
    throw new Error("OTel Worker configuration contains an inline credential");
  }

  const producers = new Map((config.queues?.producers ?? []).map((entry) => [entry.binding, entry.queue]));
  for (const [binding, queue] of Object.entries(expectedQueues)) {
    if (producers.get(binding) !== queue) throw new Error(`missing producer ${binding}`);
  }
  const consumers = config.queues?.consumers ?? [];
  if (consumers.length !== expectedConsumers.length) throw new Error("OTel Worker must have four Queue consumers");
  for (const queue of expectedConsumers) {
    const consumer = consumers.find((entry) => entry.queue === queue);
    const expectedDeadLetterQueue = `${queue.replace(/-v1$/, "")}-dlq-v1`;
    if (
      !consumer ||
      consumer.dead_letter_queue !== expectedDeadLetterQueue ||
      consumer.max_retries !== 2
    ) {
      throw new Error(`consumer contract is incomplete for ${queue}`);
    }
  }

  if (!config.r2_buckets?.some((entry) => entry.binding === "OTEL_OBJECTS")) {
    throw new Error("OTEL_OBJECTS R2 binding is missing");
  }
  const durableBindings = new Set((config.durable_objects?.bindings ?? []).map((entry) => entry.name));
  for (const binding of ["OTEL_RATE_LIMIT", "OTEL_LEDGER", "OTEL_TRACE_AGGREGATE", "OTEL_METRICS_AGGREGATE"]) {
    if (!durableBindings.has(binding)) throw new Error(`Durable Object binding is missing: ${binding}`);
  }
  const exports = Object.keys(config.exports ?? {}).sort();
  if (exports.join(",") !== "OtelLedger,OtelMetricsAggregate,OtelRateLimit,TraceAggregate") {
    throw new Error("OTel Worker Durable Object exports are incomplete");
  }
  if (config.routes?.some((route) => typeof route === "string" && !route.includes("workers.dev"))) {
    throw new Error("initial OTel Worker routes must remain on workers.dev");
  }
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const configPath = resolve(root, "workers/wrangler.otel.jsonc");
  const rawConfig = readFileSync(configPath, "utf8");
  validateOtelWorkerConfig(parseJsonc(rawConfig), rawConfig);
  process.stdout.write("OTel Worker configuration validation passed\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, "verify-otel-worker-config.mjs")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
