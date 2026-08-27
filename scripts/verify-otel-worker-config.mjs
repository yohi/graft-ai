import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseJsonc } from "./parse-jsonc.mjs";

const expectedQueues = {
  OTEL_INGRESS_QUEUE: "graft-ai-aig-otel-ingress-v1",
  OTEL_TEMPO_QUEUE: "graft-ai-aig-otel-tempo-v1",
  OTEL_LOKI_QUEUE: "graft-ai-aig-otel-loki-v1",
  OTEL_PROMETHEUS_QUEUE: "graft-ai-aig-otel-prometheus-v1",
  OTEL_INGRESS_DLQ: "graft-ai-aig-otel-ingress-dlq-v1",
  OTEL_TEMPO_DLQ: "graft-ai-aig-otel-tempo-dlq-v1",
  OTEL_LOKI_DLQ: "graft-ai-aig-otel-loki-dlq-v1",
  OTEL_PROMETHEUS_DLQ: "graft-ai-aig-otel-prometheus-dlq-v1",
};

const expectedQueueMaxRetries = 7;

const expectedConsumers = [
  "graft-ai-aig-otel-ingress-v1",
  "graft-ai-aig-otel-tempo-v1",
  "graft-ai-aig-otel-loki-v1",
  "graft-ai-aig-otel-prometheus-v1",
];

export function validateOtelWorkerConfig(
  config,
  rawConfig,
  {
    payloadStore = config.vars?.OTEL_PAYLOAD_STORE ?? "kv",
    includeR2Binding,
  } = {},
) {
  validateBasicConfig(config, rawConfig);
  validateQueues(config);
  validateStorage(config, { payloadStore, includeR2Binding });
  validateDurableObjects(config);
}

function validateBasicConfig(config, rawConfig) {
  if (config.name !== "graft-ai-aig-otel")
    throw new Error("unexpected OTel Worker name");
  if (config.main !== "src/otel.ts" && config.main !== "../src/otel.ts")
    throw new Error("OTel Worker must use src/otel.ts");
  if (config.workers_dev !== true)
    throw new Error("OTel Worker must keep workers_dev enabled");
  if (config.migrations !== undefined)
    throw new Error(
      "legacy migrations are forbidden for SQLite Durable Objects",
    );
  if (/protobuf/i.test(rawConfig))
    throw new Error("OTel Worker configuration must be JSON-only");
  if (
    /["']?(?:authorization|otel_ingest_token|otel_rate_limit_hmac_key)["']?\s*:/i.test(
      rawConfig,
    )
  ) {
    throw new Error("OTel Worker configuration contains an inline credential");
  }
  if (config.route !== undefined || (config.routes?.length ?? 0) > 0) {
    throw new Error("initial OTel Worker routes must remain on workers.dev");
  }
}

function validateQueues(config) {
  const producerEntries = config.queues?.producers ?? [];
  if (producerEntries.length !== 8)
    throw new Error("OTel Worker must have four source and four DLQ producers");
  const producers = new Map(
    producerEntries.map((entry) => [entry.binding, entry.queue]),
  );
  if (producers.size !== producerEntries.length)
    throw new Error("OTel Worker must not have duplicate producer bindings");
  for (const [binding, queue] of Object.entries(expectedQueues)) {
    if (producers.get(binding) !== queue)
      throw new Error(`missing producer ${binding}`);
  }
  if (producers.size !== 8)
    throw new Error("OTel Worker must have four source and four DLQ producers");
  const consumers = config.queues?.consumers ?? [];
  if (consumers.length !== expectedConsumers.length)
    throw new Error("OTel Worker must have four Queue consumers");
  for (const queue of expectedConsumers) {
    const consumer = consumers.find((entry) => entry.queue === queue);
    const expectedDeadLetterQueue = `${queue.replace(/-v1$/, "")}-dlq-v1`;
    if (
      !consumer ||
      consumer.dead_letter_queue !== expectedDeadLetterQueue ||
      consumer.max_retries !== expectedQueueMaxRetries
    ) {
      throw new Error(`consumer contract is incomplete for ${queue}`);
    }
  }
}

function validateStorage(config, { payloadStore, includeR2Binding }) {
  if (payloadStore !== "kv" && payloadStore !== "r2") {
    throw new Error("OTEL_PAYLOAD_STORE must be kv or r2");
  }
  if (config.vars?.OTEL_PAYLOAD_STORE !== payloadStore) {
    throw new Error(
      "OTEL_PAYLOAD_STORE selector does not match the selected mode",
    );
  }
  const kvBindings = config.kv_namespaces ?? [];
  const kvBinding = kvBindings.find(
    (entry) => entry.binding === "OTEL_PAYLOAD_KV",
  );
  if (
    !kvBinding ||
    !/^(?:__OTEL_PAYLOAD_KV_NAMESPACE_ID__|[0-9a-f]{32})$/i.test(
      kvBinding.id ?? "",
    )
  ) {
    throw new Error("OTEL_PAYLOAD_KV namespace binding is missing or invalid");
  }

  const hasR2Binding = (config.r2_buckets ?? []).some(
    (entry) =>
      entry.binding === "OTEL_OBJECTS" &&
      entry.bucket_name === "graft-ai-aig-otel-v1",
  );
  const r2Requested = includeR2Binding ?? hasR2Binding;
  if (r2Requested && !hasR2Binding) {
    throw new Error("OTEL_OBJECTS R2 binding is required for this mode");
  }
  if (!r2Requested && (config.r2_buckets?.length ?? 0) > 0) {
    throw new Error("OTEL_OBJECTS R2 binding is not permitted in KV-only mode");
  }
  if (payloadStore === "r2" && !r2Requested) {
    throw new Error("R2 payloadStore requires the R2 binding");
  }
}

function validateDurableObjects(config) {
  const durableBindings = new Set(
    (config.durable_objects?.bindings ?? []).map((entry) => entry.name),
  );
  for (const binding of [
    "OTEL_RATE_LIMIT",
    "OTEL_LEDGER",
    "OTEL_TRACE_AGGREGATE",
    "OTEL_METRICS_AGGREGATE",
  ]) {
    if (!durableBindings.has(binding))
      throw new Error(`Durable Object binding is missing: ${binding}`);
  }
  const exports = Object.keys(config.exports ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    exports.join(",") !==
    "OtelLedger,OtelMetricsAggregate,OtelRateLimit,TraceAggregate"
  ) {
    throw new Error("OTel Worker Durable Object exports are incomplete");
  }
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const configPath = resolve(root, "workers/wrangler.otel.jsonc");
  const rawConfig = readFileSync(configPath, "utf8");
  validateOtelWorkerConfig(parseJsonc(rawConfig), rawConfig);
  process.stdout.write("OTel Worker configuration validation passed\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    resolve(import.meta.dirname, "verify-otel-worker-config.mjs")
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
