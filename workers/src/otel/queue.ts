import {
  DOWNSTREAM_EXPORT_ATTEMPT_LIMIT,
  KV_PAYLOAD_READ_RETRY_DELAYS_SECONDS,
  type Backend,
  type PayloadStoreBackend,
} from "./contracts";
import { exportPointer } from "./exporter";
import { ledgerCall, type ExportClaimResult, type IngressRecord } from "./ledger";
import type { OtelIngressEnvelope } from "./ingress";
import { payloadStoreForPointer } from "./storage";
import { PayloadStoreError, PayloadStoreNotFoundError, PayloadStoreTemporaryError } from "./types";
import type {
  ExportClaim,
  ExportPointer,
  ExportResult,
  IngressPointer,
  MetricSample,
  OtelEnv,
  QueuePointer,
} from "./types";

const INGRESS_QUEUE_NAME = "graft-ai-aig-otel-ingress-v1";
const BACKEND_QUEUE_NAMES: Readonly<Record<string, Backend>> = {
  "graft-ai-aig-otel-tempo-v1": "tempo",
  "graft-ai-aig-otel-loki-v1": "loki",
  "graft-ai-aig-otel-prometheus-v1": "prometheus",
};

export type QueueDisposition =
  | Readonly<{ kind: "ack" }>
  | Readonly<{ kind: "retry"; delaySeconds: number }>
  | Readonly<{ kind: "dead-letter"; pointer: QueuePointer }>;

export async function handleQueue(
  batch: MessageBatch<QueuePointer>,
  env: OtelEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const backend = BACKEND_QUEUE_NAMES[batch.queue];
  if (batch.queue !== INGRESS_QUEUE_NAME && !backend) throw new Error("unsupported queue");
  for (const message of batch.messages) {
    try {
      let disposition: QueueDisposition;
      if (batch.queue === INGRESS_QUEUE_NAME) {
        if (message.body.kind !== "ingress") throw new Error("unsupported pointer");
        disposition = await consumeIngress(message.body, env);
      } else {
        if (message.body.kind !== "export" || message.body.backend !== backend) {
          throw new Error("backend pointer mismatch");
        }
        disposition = await consumeExport(message.body, env, backend);
      }
      await applyDisposition(message, disposition, env);
    } catch {
      message.retry({ delaySeconds: 1 });
    }
  }
}

async function consumeIngress(pointer: IngressPointer, env: OtelEnv): Promise<QueueDisposition> {
  if (pointer.kind !== "ingress") throw new Error("unsupported pointer");
  const ledger = env.OTEL_LEDGER.getByName("global");
  const record = await ledgerCall<IngressRecord | null>(ledger, "ingress.record", {
    ingressId: pointer.ingressId,
  });
  if (!record || record.status === "complete" || record.status === "expired") {
    return { kind: "ack" };
  }
  const durablePointer = record.pointer ?? pointer;
  const backend = payloadBackend(durablePointer);
  let envelope: OtelIngressEnvelope;
  try {
    envelope = await payloadStoreForPointer(
      env,
      durablePointer,
    ).readJsonObject<OtelIngressEnvelope>(durablePointer);
  } catch (error) {
    if (!(error instanceof PayloadStoreError)) throw error;
    await appendPayloadStoreFailure(env, "read", backend, error);
    const ordinal = await ledgerCall<number>(ledger, "ingress.payload-read-failure", {
      ingressId: pointer.ingressId,
    });
    if (
      backend === "kv" &&
      (error instanceof PayloadStoreNotFoundError || error instanceof PayloadStoreTemporaryError) &&
      ordinal <= KV_PAYLOAD_READ_RETRY_DELAYS_SECONDS.length
    ) {
      return {
        kind: "retry",
        delaySeconds: KV_PAYLOAD_READ_RETRY_DELAYS_SECONDS[ordinal - 1] ?? 120,
      };
    }
    return { kind: "dead-letter", pointer: durablePointer };
  }

  const byTrace = new Map<string, typeof envelope.spans>();
  for (const span of envelope.spans) {
    const spans = byTrace.get(span.traceId) ?? [];
    byTrace.set(span.traceId, [...spans, span]);
  }
  for (const [traceId, spans] of byTrace) {
    const response = await env.OTEL_TRACE_AGGREGATE.getByName(traceId).fetch(
      "https://trace/ingest",
      {
        method: "POST",
        body: JSON.stringify({
          traceId,
          ingressId: pointer.ingressId,
          receivedAtMs: pointer.createdAtMs,
          spans,
        }),
      },
    );
    if (!response.ok) throw new Error(`trace aggregate rejected: ${response.status}`);
  }
  const completed = await ledgerCall<boolean>(ledger, "ingress.complete", {
    ingressId: pointer.ingressId,
  });
  if (!completed) throw new Error("ingress completion rejected");
  try {
    await payloadStoreForPointer(env, durablePointer).deleteObject(durablePointer);
  } catch (error) {
    if (!(error instanceof PayloadStoreError)) throw error;
    await appendPayloadStoreFailure(env, "delete", backend, error);
    return { kind: "dead-letter", pointer: durablePointer };
  }
  return { kind: "ack" };
}

async function consumeExport(
  pointer: ExportPointer,
  env: OtelEnv,
  backend: Backend | undefined,
): Promise<QueueDisposition> {
  if (pointer.kind !== "export" || pointer.backend !== backend) {
    throw new Error("backend pointer mismatch");
  }
  const ledger = env.OTEL_LEDGER.getByName("global");
  const ownerId = crypto.randomUUID();
  const claim = await ledgerCall<ExportClaimResult>(ledger, "export.claim", {
    jobId: pointer.jobId,
    ownerId,
    nowMs: Date.now(),
  });
  if (claim.kind === "complete" || claim.kind === "expired") return { kind: "ack" };
  if (claim.kind !== "claimed") return { kind: "retry", delaySeconds: 1 };

  const durablePointer = claim.pointer;
  const pointerBackend = payloadBackend(durablePointer);
  let result: ExportResult;
  try {
    result = await exportPointer(durablePointer, env);
  } catch (error) {
    await releaseClaim(ledger, claim.claim);
    if (!(error instanceof PayloadStoreError)) throw error;
    await appendPayloadStoreFailure(env, "read", pointerBackend, error);
    const ordinal = await ledgerCall<number>(ledger, "export.payload-read-failure", {
      jobId: durablePointer.jobId,
    });
    if (
      pointerBackend === "kv" &&
      (error instanceof PayloadStoreNotFoundError || error instanceof PayloadStoreTemporaryError) &&
      ordinal <= KV_PAYLOAD_READ_RETRY_DELAYS_SECONDS.length
    ) {
      return {
        kind: "retry",
        delaySeconds: KV_PAYLOAD_READ_RETRY_DELAYS_SECONDS[ordinal - 1] ?? 120,
      };
    }
    return { kind: "dead-letter", pointer: durablePointer };
  }

  if (result.kind === "success") {
    const completed = await ledgerCall<boolean>(ledger, "export.complete", {
      claim: claim.claim,
    });
    if (!completed) throw new Error("export completion rejected");
    try {
      await payloadStoreForPointer(env, durablePointer).deleteObject(durablePointer);
    } catch (error) {
      if (!(error instanceof PayloadStoreError)) throw error;
      await appendPayloadStoreFailure(env, "delete", pointerBackend, error);
      return { kind: "dead-letter", pointer: durablePointer };
    }
    return { kind: "ack" };
  }

  await releaseClaim(ledger, claim.claim);
  const ordinal = await ledgerCall<number>(ledger, "export.downstream-failure", {
    jobId: durablePointer.jobId,
  });
  await appendOperationalSamples(env, [
    failureSample(durablePointer.backend, durablePointer.jobId, ordinal, result),
  ]);
  if (result.kind === "terminal" || ordinal >= DOWNSTREAM_EXPORT_ATTEMPT_LIMIT) {
    await appendOperationalSamples(env, [
      exhaustedSample(durablePointer.backend, durablePointer.jobId, ordinal),
    ]);
    return { kind: "dead-letter", pointer: durablePointer };
  }

  await appendOperationalSamples(env, [
    retrySample(durablePointer.backend, durablePointer.jobId, ordinal),
  ]);
  const defaultDelay = ordinal === 1 ? 1 : 2;
  const retryAfterSeconds = result.kind === "retryable" ? result.retryAfterSeconds : undefined;
  return { kind: "retry", delaySeconds: Math.max(defaultDelay, retryAfterSeconds ?? 0) };
}

async function applyDisposition(
  message: Message<QueuePointer>,
  disposition: QueueDisposition,
  env: OtelEnv,
): Promise<void> {
  switch (disposition.kind) {
    case "ack":
      message.ack();
      return;
    case "retry":
      message.retry({ delaySeconds: disposition.delaySeconds });
      return;
    case "dead-letter":
      await deadLetterPointer(env, disposition.pointer);
      message.ack();
      return;
    default:
      return assertNever(disposition);
  }
}

export async function deadLetterPointer(env: OtelEnv, pointer: QueuePointer): Promise<void> {
  if (pointer.kind === "ingress") {
    if (!env.OTEL_INGRESS_DLQ) throw new Error("OTEL_INGRESS_DLQ binding is missing");
    await env.OTEL_INGRESS_DLQ.send(pointer);
    return;
  }
  switch (pointer.backend) {
    case "tempo":
      if (!env.OTEL_TEMPO_DLQ) throw new Error("OTEL_TEMPO_DLQ binding is missing");
      await env.OTEL_TEMPO_DLQ.send(pointer);
      return;
    case "loki":
      if (!env.OTEL_LOKI_DLQ) throw new Error("OTEL_LOKI_DLQ binding is missing");
      await env.OTEL_LOKI_DLQ.send(pointer);
      return;
    case "prometheus":
      if (!env.OTEL_PROMETHEUS_DLQ) throw new Error("OTEL_PROMETHEUS_DLQ binding is missing");
      await env.OTEL_PROMETHEUS_DLQ.send(pointer);
      return;
    default:
      return assertNever(pointer.backend);
  }
}

function payloadBackend(pointer: QueuePointer): PayloadStoreBackend {
  return pointer.schemaVersion === 1 ? "r2" : pointer.storageBackend;
}

function failureSample(
  backend: Backend,
  jobId: string,
  attempt: number,
  result: Exclude<Awaited<ReturnType<typeof exportPointer>>, { kind: "success" }>,
): MetricSample {
  return {
    sampleId: `${jobId}:failure:${attempt}`,
    name: "otel_backend_export_failures_total",
    kind: "sum",
    value: 1,
    labels: { backend, status_class: statusClass(result) },
  };
}

function retrySample(backend: Backend, jobId: string, attempt: number): MetricSample {
  return {
    sampleId: `${jobId}:retry:${attempt}`,
    name: "otel_backend_export_retries_total",
    kind: "sum",
    value: 1,
    labels: { backend },
  };
}

function exhaustedSample(backend: Backend, jobId: string, attempt: number): MetricSample {
  return {
    sampleId: `${jobId}:exhausted:${attempt}`,
    name: "otel_backend_export_exhausted_total",
    kind: "sum",
    value: 1,
    labels: { backend },
  };
}

function statusClass(
  result: Exclude<Awaited<ReturnType<typeof exportPointer>>, { kind: "success" }>,
): string {
  if (result.status !== undefined) return `${Math.floor(result.status / 100)}xx`;
  return result.kind === "retryable" ? result.reason : "terminal";
}

async function appendPayloadStoreFailure(
  env: OtelEnv,
  operation: "read" | "write" | "delete",
  backend: PayloadStoreBackend,
  error: PayloadStoreError,
): Promise<void> {
  await appendOperationalSamples(env, [
    {
      sampleId: `otel-payload-store:${operation}:${backend}:${error.errorClass}:${crypto.randomUUID()}`,
      name: "otel_payload_store_operation_failures_total",
      kind: "sum",
      value: 1,
      labels: {
        operation,
        storage_backend: backend,
        error_class: error.errorClass,
      },
    },
  ]);
}

async function appendOperationalSamples(
  env: OtelEnv,
  samples: readonly MetricSample[],
): Promise<void> {
  try {
    const response = await env.OTEL_METRICS_AGGREGATE.getByName("global").fetch(
      "https://metrics/append",
      {
        method: "POST",
        body: JSON.stringify({ samples, nowMs: Date.now() }),
      },
    );
    if (!response.ok) throw new Error(`metrics aggregate rejected: ${response.status}`);
  } catch {}
}

async function releaseClaim(ledger: DurableObjectStub, claim: ExportClaim): Promise<void> {
  const released = await ledgerCall<boolean>(ledger, "export.release", { claim });
  if (!released) throw new Error("export release rejected");
}

function assertNever(value: never): never {
  throw new Error(`unexpected queue disposition: ${String(value)}`);
}
