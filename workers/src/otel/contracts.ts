export const MAX_INGRESS_BYTES = 8 * 1024 * 1024;
export const MAX_GRAFANA_OTLP_BYTES = 4_000_000;
export const MAX_LOKI_LINE_BYTES = 262_144;
export const MAX_CONCURRENT_REQUESTS = 100;
export const ACTIVE_REQUEST_LEASE_MS = 35_000;
export const MAX_INGRESS_RESERVATIONS = 1_000;
export const RATE_LIMIT_CAPACITY = 20;
export const RATE_LIMIT_REFILL_PER_SECOND = 2;
export const RATE_LIMIT_RETRY_AFTER_MINIMUM_SECONDS = 1;
export const TRACE_IDLE_ALARM_MS = 1_000;
export const METRICS_FLUSH_INTERVAL_MS = 30_000;
export const METRICS_FLUSH_SAMPLE_LIMIT = 200;
export const DEDUPLICATION_TOMBSTONE_MS = 25 * 60 * 60 * 1_000;
export const PAYLOAD_RETENTION_FAILSAFE_MS = 7 * 24 * 60 * 60 * 1_000;
export const PAYLOAD_RETENTION_TTL_SECONDS = PAYLOAD_RETENTION_FAILSAFE_MS / 1_000;
export const KV_PROPAGATION_DELAY_SECONDS = 60;
export const KV_PAYLOAD_READ_RETRY_DELAYS_SECONDS = [5, 15, 30, 60, 120] as const;
export const DOWNSTREAM_EXPORT_ATTEMPT_LIMIT = 3;
export const OTEL_QUEUE_MAX_RETRIES = 7;
export const PAYLOAD_STORE_BACKENDS = ["kv", "r2"] as const;
export type PayloadStoreBackend = (typeof PAYLOAD_STORE_BACKENDS)[number];
export const MAX_JSON_DEPTH = 64;

export const BACKEND_EXPORT_TIMEOUT_MS = {
  tempo: 10_000,
  loki: 10_000,
  prometheus: 10_000,
} as const;

export type Backend = keyof typeof BACKEND_EXPORT_TIMEOUT_MS;

export const LOKI_LABEL_KEYS = ["model", "status_code", "env", "gateway"] as const;

export const METRIC_LABEL_KEYS = ["model", "provider", "status_code", "env", "gateway"] as const;

export const SAMPLING_SEED = "graft-ai-otel-v1";

export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export const DURATION_OVERFLOW_SENTINEL = Infinity;

export const CANONICAL_METRIC_NAMES = [
  "ai_gateway_requests_total",
  "ai_gateway_errors_total",
  "ai_gateway_request_duration_seconds",
] as const;

export const REDACTION_FAILURE_REASON = "redaction_failure" as const;
export const NUMERIC_FIELD_INVALID_REASON = "numeric_field_invalid" as const;
export const LINE_SIZE_METADATA_REASON = "line_size_metadata" as const;
export const TRUNCATED_SUFFIX = "[TRUNCATED]" as const;
export const REDACTED_VALUE = "[REDACTED]" as const;

export const ATTRIBUTE_ALIASES = {
  model: ["model", "gen_ai.request.model"],
  provider: ["provider", "gen_ai.model.provider", "gen_ai.provider.name", "gen_ai.system"],
  request_id: ["request_id", "cf-aig-request-id"],
  status_code: ["status_code", "http.response.status_code"],
  input_tokens: ["input_tokens", "gen_ai.usage.input_tokens"],
  output_tokens: ["output_tokens", "gen_ai.usage.output_tokens"],
  total_tokens: ["total_tokens", "gen_ai.usage.total_tokens"],
  cost_usd: ["cost_usd", "gen_ai.usage.cost", "gen_ai.usage.cost_usd"],
} as const;
