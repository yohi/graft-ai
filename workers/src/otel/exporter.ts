import { BACKEND_EXPORT_TIMEOUT_MS, MAX_GRAFANA_OTLP_BYTES, type Backend } from "./contracts";
import { ledgerCall, type ExportRegistrationResult } from "./ledger";
import { exportObjectKey, putBytesObject, readBytesObject, sha256Hex } from "./storage";
import type { ExportPointer, ExportResult, JobDescriptor, OtelEnv } from "./types";

export async function enqueueBackendJob(
  env: OtelEnv,
  descriptor: JobDescriptor,
  bytes: Uint8Array,
): Promise<ExportPointer> {
  validateDescriptor(descriptor, bytes);
  const payloadSha256 = await sha256Hex(bytes);
  if (descriptor.payloadSha256 !== payloadSha256)
    throw new Error("export payload checksum mismatch");
  const nowMs = Date.now();
  const pointer: ExportPointer = {
    ...descriptor,
    schemaVersion: 1,
    id: descriptor.jobId,
    objectKey: exportObjectKey(
      descriptor.backend,
      descriptor.jobId,
      new Date(nowMs).toISOString().slice(0, 10),
    ),
    sha256: payloadSha256,
    createdAtMs: nowMs,
    kind: "export",
    payloadSha256,
  };
  const ledger = env.OTEL_LEDGER.getByName("global");
  const registered = await ledgerCall<ExportRegistrationResult>(ledger, "export.register", {
    descriptor,
    nowMs,
  });
  if (registered.kind === "collision") throw new Error("export job collision");
  if (registered.kind === "duplicate") {
    if (!registered.pointer) {
      if (registered.status !== "reserved") throw new Error("export pointer missing");
    } else if (registered.status === "ready") {
      await backendQueue(env, registered.pointer.backend).send(registered.pointer);
      const enqueued = await ledgerCall<boolean>(ledger, "export.enqueued", {
        jobId: registered.pointer.jobId,
      });
      if (!enqueued) throw new Error("export enqueue transition rejected");
      return registered.pointer;
    } else if (registered.status === "expired") {
      throw new Error("export job expired");
    } else {
      return registered.pointer;
    }
  }

  try {
    await putBytesObject(env.OTEL_OBJECTS, pointer.objectKey, bytes, "export");
  } catch (error) {
    await ledgerCall(ledger, "export.release-reservation", { jobId: descriptor.jobId });
    throw error;
  }
  const ready = await ledgerCall<boolean>(ledger, "export.ready", {
    jobId: descriptor.jobId,
    pointer,
    nowMs,
  });
  if (!ready) {
    const released = await ledgerCall<boolean>(ledger, "export.release-reservation", {
      jobId: descriptor.jobId,
    });
    if (released) await env.OTEL_OBJECTS.delete(pointer.objectKey);
    throw new Error("export ready transition rejected");
  }

  await backendQueue(env, descriptor.backend).send(pointer);
  const enqueued = await ledgerCall<boolean>(ledger, "export.enqueued", {
    jobId: descriptor.jobId,
  });
  if (!enqueued) throw new Error("export enqueue transition rejected");
  return pointer;
}

export async function exportPointer(pointer: ExportPointer, env: OtelEnv): Promise<ExportResult> {
  const bytes = await readBytesObject(env.OTEL_OBJECTS, pointer);
  const config = backendConfig(pointer.backend, env);
  if (!config.url || !config.authorization) return { kind: "terminal", status: 503 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_EXPORT_TIMEOUT_MS[pointer.backend]);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": pointer.contentType,
        authorization: config.authorization,
      },
      body: bytes,
      signal: controller.signal,
    });
    if (response.status >= 200 && response.status < 300) {
      return { kind: "success", status: response.status };
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return {
        kind: "retryable",
        reason: "http",
        status: response.status,
        ...retryAfter(response.headers.get("retry-after")),
      };
    }
    return { kind: "terminal", status: response.status };
  } catch (error) {
    if (controller.signal.aborted) return { kind: "retryable", reason: "timeout" };
    if (error instanceof Error) return { kind: "retryable", reason: "network" };
    return { kind: "retryable", reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}

export function isRetryable(result: ExportResult): boolean {
  return result.kind === "retryable";
}

export async function traceJobId(
  backend: Backend,
  traceId: string,
  payloadSha256: string,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`trace\0${backend}\0${traceId}\0${payloadSha256}`));
}

export async function metricsJobId(
  backend: Backend,
  windowStartUnixNano: string,
  windowEndUnixNano: string,
  payloadSha256: string,
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      `metrics\0${backend}\0${windowStartUnixNano}\0${windowEndUnixNano}\0${payloadSha256}`,
    ),
  );
}

function validateDescriptor(descriptor: JobDescriptor, bytes: Uint8Array): void {
  if (
    !descriptor.jobId ||
    !descriptor.contentType ||
    descriptor.contentType !== "application/json"
  ) {
    throw new TypeError("invalid export descriptor");
  }
  if (bytes.byteLength > MAX_GRAFANA_OTLP_BYTES) throw new Error("export payload too large");
}

function backendQueue(env: OtelEnv, backend: Backend): Queue<ExportPointer> {
  if (backend === "tempo") return env.OTEL_TEMPO_QUEUE;
  if (backend === "loki") return env.OTEL_LOKI_QUEUE;
  return env.OTEL_PROMETHEUS_QUEUE;
}

function backendConfig(
  envBackend: Backend,
  env: OtelEnv,
): Readonly<{ url: string; authorization: string }> {
  if (envBackend === "tempo") {
    return {
      url: env.GRAFANA_CLOUD_OTLP_TRACES_URL,
      authorization: env.GRAFANA_CLOUD_OTLP_AUTHORIZATION,
    };
  }
  if (envBackend === "loki") {
    return {
      url: env.GRAFANA_CLOUD_LOKI_URL,
      authorization: env.GRAFANA_CLOUD_LOKI_AUTHORIZATION,
    };
  }
  return {
    url: env.GRAFANA_CLOUD_OTLP_METRICS_URL,
    authorization: env.GRAFANA_CLOUD_OTLP_AUTHORIZATION,
  };
}

function retryAfter(value: string | null): Readonly<{ retryAfterSeconds?: number }> {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value.trim())) return {};
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSeconds: seconds } : {};
}
