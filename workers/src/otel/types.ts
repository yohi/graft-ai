import type { Backend, LOKI_LABEL_KEYS, METRIC_LABEL_KEYS } from "./contracts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export type Attributes = Readonly<Record<string, JsonValue>>;
export type LokiLabelKey = (typeof LOKI_LABEL_KEYS)[number];
export type MetricLabelKey = (typeof METRIC_LABEL_KEYS)[number];

export type CanonicalSpan = Readonly<{
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: string;
  statusCode: string;
  statusMessage: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attributes;
  resourceAttributes: Attributes;
}>;

export type RedactedSpan = CanonicalSpan &
  Readonly<{
    payloadDropped: boolean;
    payloadDropReason?: string;
  }>;

export type SelectedTrace = Readonly<{
  traceId: string;
  spans: readonly RedactedSpan[];
  requestSpan: RedactedSpan | null;
}>;

export type MetricKind = "sum" | "histogram";

export type MetricSample = Readonly<{
  name: string;
  kind: MetricKind;
  value: number;
  labels: Readonly<Record<string, string>>;
  count?: string;
  bucketCounts?: readonly string[];
  explicitBounds?: readonly number[];
}>;

export type MetricWindow = Readonly<{
  startTimeUnixNano: string;
  endTimeUnixNano: string;
}>;

export type LokiRecord = Readonly<{
  labels: Readonly<Record<LokiLabelKey, string>>;
  timestampUnixNano: string;
  line: string;
}>;

export type BackendJobIdentity =
  | Readonly<{ kind: "trace"; traceId: string }>
  | Readonly<{
      kind: "metrics";
      windowStartUnixNano: string;
      windowEndUnixNano: string;
    }>;

export type ObjectPointer = Readonly<{
  schemaVersion: 1;
  id: string;
  objectKey: string;
  sha256: string;
  contentType: "application/json";
  createdAtMs: number;
}>;

export type IngressPointer = ObjectPointer & Readonly<{ kind: "ingress"; ingressId: string }>;

export type JobDescriptor = Readonly<{
  jobId: string;
  backend: Backend;
  contentType: "application/json";
  identity: BackendJobIdentity;
  payloadSha256: string;
}>;

export type ExportPointer = ObjectPointer & JobDescriptor & Readonly<{ kind: "export" }>;

export type QueuePointer = IngressPointer | ExportPointer;

export type ActiveRequestLease = Readonly<{
  ownerId: string;
  fencingToken: string;
  expiresAtMs: number;
}>;

export type ExportClaim = ActiveRequestLease & Readonly<{ jobId: string }>;

export type ExportResult =
  | Readonly<{ kind: "success"; status: number }>
  | Readonly<{
      kind: "retryable";
      reason: "timeout" | "network" | "http";
      status?: number;
      retryAfterSeconds?: number;
    }>
  | Readonly<{ kind: "terminal"; status: number }>;

export interface OtelEnv {
  readonly OTEL_INGRESS_QUEUE: Queue<IngressPointer>;
  readonly OTEL_TEMPO_QUEUE: Queue<ExportPointer>;
  readonly OTEL_LOKI_QUEUE: Queue<ExportPointer>;
  readonly OTEL_PROMETHEUS_QUEUE: Queue<ExportPointer>;
  readonly OTEL_OBJECTS: R2Bucket;
  readonly OTEL_RATE_LIMIT: DurableObjectNamespace;
  readonly OTEL_LEDGER: DurableObjectNamespace;
  readonly OTEL_TRACE_AGGREGATE: DurableObjectNamespace;
  readonly OTEL_METRICS_AGGREGATE: DurableObjectNamespace;
  readonly OTEL_INGEST_TOKEN: string;
  readonly OTEL_RATE_LIMIT_HMAC_KEY: string;
  readonly GRAFANA_CLOUD_OTLP_TRACES_URL: string;
  readonly GRAFANA_CLOUD_OTLP_METRICS_URL: string;
  readonly GRAFANA_CLOUD_OTLP_AUTHORIZATION: string;
  readonly GRAFANA_CLOUD_LOKI_URL: string;
  readonly GRAFANA_CLOUD_LOKI_AUTHORIZATION: string;
  readonly GATEWAY_NAME: string;
  readonly ENV_LABEL: string;
  readonly OTEL_SAMPLING_RATE: string;
  readonly OTEL_GRAFANA_CLOUD_LOGS_RETENTION: string;
}
