import { exportPointer } from "./exporter";
import type { Backend } from "./contracts";
import { ledgerCall, type ExportClaimResult, type IngressRecord } from "./ledger";
import { readJsonObject } from "./storage";
import type { ExportPointer, IngressPointer, MetricSample, OtelEnv, QueuePointer } from "./types";
import type { OtelIngressEnvelope } from "./ingress";

const INGRESS_QUEUE_NAME = "graft-ai-aig-otel-ingress-v1";
const BACKEND_QUEUE_NAMES: Readonly<Record<string, Backend>> = {
  "graft-ai-aig-otel-tempo-v1": "tempo",
  "graft-ai-aig-otel-loki-v1": "loki",
  "graft-ai-aig-otel-prometheus-v1": "prometheus",
};

export async function handleQueue(
  batch: MessageBatch<QueuePointer>,
  env: OtelEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const backend = BACKEND_QUEUE_NAMES[batch.queue];
  if (batch.queue !== INGRESS_QUEUE_NAME && !backend) throw new Error("unsupported queue");
  let deadLettered = false;
  for (const message of batch.messages) {
    try {
      if (batch.queue === INGRESS_QUEUE_NAME) {
        if (message.body.kind !== "ingress") throw new Error("unsupported pointer");
        await consumeIngress(message.body, env);
        message.ack();
        continue;
      }
      if (message.body.kind !== "export" || message.body.backend !== backend) {
        throw new Error("backend pointer mismatch");
      }
      await consumeExport(message.body, message, env);
    } catch (error) {
      if (error instanceof ExportDeadLetterError) {
        deadLettered = true;
        continue;
      }
      message.retry({ delaySeconds: 1 });
    }
  }
  if (deadLettered) throw new Error("one or more export messages moved to the DLQ");
}

async function consumeIngress(pointer: IngressPointer, env: OtelEnv): Promise<void> {
  if (pointer.kind !== "ingress") throw new Error("unsupported pointer");
  const ledger = env.OTEL_LEDGER.getByName("global");
  const record = await ledgerCall<IngressRecord | null>(ledger, "ingress.record", {
    ingressId: pointer.ingressId,
  });
  if (!record || record.status === "complete" || record.status === "expired") return;
  const durablePointer = record.pointer ?? pointer;
  const envelope = await readJsonObject<OtelIngressEnvelope>(env.OTEL_OBJECTS, durablePointer);
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
  await env.OTEL_OBJECTS.delete(durablePointer.objectKey);
}

async function consumeExport(
  pointer: ExportPointer,
  message: Message<QueuePointer>,
  env: OtelEnv,
): Promise<void> {
  const ledger = env.OTEL_LEDGER.getByName("global");
  const ownerId = crypto.randomUUID();
  const claim = await ledgerCall<ExportClaimResult>(ledger, "export.claim", {
    jobId: pointer.jobId,
    ownerId,
    nowMs: Date.now(),
  });
  if (claim.kind === "complete" || claim.kind === "expired") {
    message.ack();
    return;
  }
  if (claim.kind !== "claimed") throw new Error(`export claim unavailable: ${claim.kind}`);

  let result;
  try {
    result = await exportPointer(pointer, env);
  } catch (error) {
    await releaseClaim(ledger, claim.claim);
    throw error;
  }

  if (result.kind === "success") {
    const completed = await ledgerCall<boolean>(ledger, "export.complete", { claim: claim.claim });
    if (!completed) throw new Error("export completion rejected");
    await env.OTEL_OBJECTS.delete(pointer.objectKey);
    message.ack();
    return;
  }

  await releaseClaim(ledger, claim.claim);
  await appendOperationalSamples(env, [
    failureSample(pointer.backend, pointer.jobId, message.attempts, result),
  ]);
  if (result.kind === "terminal" || message.attempts >= 3) {
    await appendOperationalSamples(env, [
      exhaustedSample(pointer.backend, pointer.jobId, message.attempts),
    ]);
    throw new ExportDeadLetterError();
  }

  await appendOperationalSamples(env, [
    retrySample(pointer.backend, pointer.jobId, message.attempts),
  ]);
  const defaultDelay = message.attempts <= 1 ? 1 : 2;
  const retryAfterSeconds = result.kind === "retryable" ? result.retryAfterSeconds : undefined;
  const delaySeconds = Math.max(defaultDelay, retryAfterSeconds ?? 0);
  message.retry({ delaySeconds });
}

class ExportDeadLetterError extends Error {
  constructor() {
    super("export message moved to the DLQ");
    this.name = "ExportDeadLetterError";
  }
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

async function releaseClaim(
  ledger: DurableObjectStub,
  claim: Readonly<Record<string, unknown>>,
): Promise<void> {
  const released = await ledgerCall<boolean>(ledger, "export.release", { claim });
  if (!released) throw new Error("export release rejected");
}
