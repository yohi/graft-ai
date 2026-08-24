import {
  KV_PROPAGATION_DELAY_SECONDS,
  PAYLOAD_RETENTION_TTL_SECONDS,
  PAYLOAD_STORE_BACKENDS,
  type Backend,
  type PayloadStoreBackend,
} from "./contracts";
import type { CurrentObjectPointer, ObjectPointer, OtelEnv, PayloadStore } from "./types";
import {
  PayloadStoreConfigurationError,
  PayloadStoreError,
  PayloadStoreIntegrityError,
  PayloadStoreNotFoundError,
  PayloadStoreQuotaError,
  PayloadStoreTemporaryError,
} from "./types";

type PayloadMetadata = Readonly<{
  schemaVersion: "1";
  sha256: string;
  contentType: "application/json";
  kind: "ingress" | "export";
}>;

const CONTENT_TYPE = "application/json" as const;

abstract class PayloadStoreBase implements PayloadStore {
  abstract readonly backend: PayloadStoreBackend;

  async putJsonObject<T>(objectKey: string, value: T): Promise<CurrentObjectPointer> {
    return this.putBytesObject(
      objectKey,
      new TextEncoder().encode(JSON.stringify(value)),
      payloadKindForObjectKey(objectKey),
    );
  }

  async readJsonObject<T>(pointer: ObjectPointer): Promise<T> {
    const bytes = await this.readBytesObject(pointer);
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return parsed as T;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new PayloadStoreIntegrityError("payload object JSON is invalid");
      }
      throw error;
    }
  }

  abstract putBytesObject(
    objectKey: string,
    bytes: Uint8Array,
    kind: "ingress" | "export",
  ): Promise<CurrentObjectPointer>;
  abstract readBytesObject(pointer: ObjectPointer): Promise<Uint8Array>;
  abstract deleteObject(pointer: ObjectPointer): Promise<void>;
}

export function resolvePayloadStoreBackend(value: string | undefined): PayloadStoreBackend {
  const selected = value?.trim() ?? "";
  if (selected === "") return "kv";
  if (selected === PAYLOAD_STORE_BACKENDS[0] || selected === PAYLOAD_STORE_BACKENDS[1]) {
    return selected;
  }
  throw new PayloadStoreConfigurationError("OTEL_PAYLOAD_STORE must be exactly kv or r2");
}

export function payloadStoreForWrite(env: OtelEnv): PayloadStore {
  return payloadStoreForBackend(env, resolvePayloadStoreBackend(env.OTEL_PAYLOAD_STORE));
}

export function payloadStoreForPointer(env: OtelEnv, pointer: ObjectPointer): PayloadStore {
  const backend = pointer.schemaVersion === 1 ? "r2" : pointer.storageBackend;
  return payloadStoreForBackend(env, backend);
}

export function queueDeliveryDelaySeconds(pointer: ObjectPointer): number {
  return pointer.schemaVersion === 2 && pointer.storageBackend === "kv"
    ? KV_PROPAGATION_DELAY_SECONDS
    : 0;
}

class KvPayloadStore extends PayloadStoreBase {
  readonly backend = "kv" as const;

  constructor(private readonly namespace: KVNamespace) {
    super();
  }

  async putBytesObject(
    objectKey: string,
    bytes: Uint8Array,
    kind: "ingress" | "export",
  ): Promise<CurrentObjectPointer> {
    const sha256 = await sha256Hex(bytes);
    const metadata = payloadMetadata(sha256, kind);
    try {
      await this.namespace.put(objectKey, bytes, {
        expirationTtl: PAYLOAD_RETENTION_TTL_SECONDS,
        metadata,
      });
    } catch (error) {
      throw classifyStoreFailure(error, "KV payload write");
    }
    return currentPointer(objectKey, sha256, this.backend);
  }

  async readBytesObject(pointer: ObjectPointer): Promise<Uint8Array> {
    let stored: KVNamespaceGetWithMetadataResult<ArrayBuffer, PayloadMetadata>;
    try {
      stored = await this.namespace.getWithMetadata<PayloadMetadata>(pointer.objectKey, {
        type: "arrayBuffer",
      });
    } catch (error) {
      throw classifyStoreFailure(error, "KV payload read");
    }
    if (stored.value === null) throw new PayloadStoreNotFoundError();
    validateMetadata(stored.metadata, pointer);
    const bytes = new Uint8Array(stored.value);
    const actualSha256 = await sha256Hex(bytes);
    if (actualSha256 !== pointer.sha256) {
      throw new PayloadStoreIntegrityError("payload object checksum mismatch");
    }
    return bytes;
  }

  async deleteObject(pointer: ObjectPointer): Promise<void> {
    try {
      await this.namespace.delete(pointer.objectKey);
    } catch (error) {
      throw classifyStoreFailure(error, "KV payload delete");
    }
  }
}

class R2PayloadStore extends PayloadStoreBase {
  readonly backend = "r2" as const;

  constructor(private readonly bucket: R2Bucket) {
    super();
  }

  async putBytesObject(
    objectKey: string,
    bytes: Uint8Array,
    kind: "ingress" | "export",
  ): Promise<CurrentObjectPointer> {
    const sha256 = await sha256Hex(bytes);
    try {
      await this.bucket.put(objectKey, bytes, {
        httpMetadata: { contentType: CONTENT_TYPE },
        customMetadata: payloadMetadata(sha256, kind),
      });
    } catch (error) {
      throw classifyStoreFailure(error, "R2 payload write");
    }
    return currentPointer(objectKey, sha256, this.backend);
  }

  async readBytesObject(pointer: ObjectPointer): Promise<Uint8Array> {
    let object: R2ObjectBody | null;
    try {
      object = await this.bucket.get(pointer.objectKey);
    } catch (error) {
      throw classifyStoreFailure(error, "R2 payload read");
    }
    if (object === null) throw new PayloadStoreNotFoundError();
    if (object.httpMetadata?.contentType !== pointer.contentType) {
      throw new PayloadStoreIntegrityError("payload object content type mismatch");
    }
    if (object.customMetadata?.sha256 !== pointer.sha256) {
      throw new PayloadStoreIntegrityError("payload object metadata checksum mismatch");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const actualSha256 = await sha256Hex(bytes);
    if (actualSha256 !== pointer.sha256) {
      throw new PayloadStoreIntegrityError("payload object checksum mismatch");
    }
    return bytes;
  }

  async deleteObject(pointer: ObjectPointer): Promise<void> {
    try {
      await this.bucket.delete(pointer.objectKey);
    } catch (error) {
      throw classifyStoreFailure(error, "R2 payload delete");
    }
  }
}

function payloadStoreForBackend(env: OtelEnv, backend: PayloadStoreBackend): PayloadStore {
  if (backend === "kv") {
    if (!env.OTEL_PAYLOAD_KV) {
      throw new PayloadStoreConfigurationError("OTEL_PAYLOAD_KV binding is missing");
    }
    return new KvPayloadStore(env.OTEL_PAYLOAD_KV);
  }
  if (!env.OTEL_OBJECTS) {
    throw new PayloadStoreConfigurationError("OTEL_OBJECTS binding is missing");
  }
  return new R2PayloadStore(env.OTEL_OBJECTS);
}

function payloadKindForObjectKey(objectKey: string): "ingress" | "export" {
  return objectKey.includes("/export/") ? "export" : "ingress";
}

function payloadMetadata(sha256: string, kind: "ingress" | "export"): PayloadMetadata {
  return { schemaVersion: "1", sha256, contentType: CONTENT_TYPE, kind };
}

function currentPointer(
  objectKey: string,
  sha256: string,
  storageBackend: PayloadStoreBackend,
): CurrentObjectPointer {
  return {
    schemaVersion: 2,
    storageBackend,
    id:
      objectKey
        .split("/")
        .pop()
        ?.replace(/\.json$/, "") ?? objectKey,
    objectKey,
    sha256,
    contentType: CONTENT_TYPE,
    createdAtMs: Date.now(),
  };
}

function validateMetadata(metadata: PayloadMetadata | null, pointer: ObjectPointer): void {
  if (metadata?.schemaVersion !== "1" || metadata?.contentType !== pointer.contentType) {
    throw new PayloadStoreIntegrityError("payload object metadata is invalid");
  }
  if (metadata.sha256 !== pointer.sha256) {
    throw new PayloadStoreIntegrityError("payload object metadata checksum mismatch");
  }
}

function classifyStoreFailure(error: unknown, operation: string): PayloadStoreError {
  if (error instanceof PayloadStoreError) return error;
  const message = error instanceof Error ? error.message : "unknown store error";
  if (/quota|daily limit|rate limit|limit exceeded/i.test(message)) {
    return new PayloadStoreQuotaError(`${operation} quota exceeded`);
  }
  return new PayloadStoreTemporaryError(`${operation} temporarily unavailable`);
}

export function ingressObjectKey(ingressId: string, date: string): string {
  return `otel/ingress/${date}/${ingressId}.json`;
}

export function exportObjectKey(backend: Backend, jobId: string, date: string): string {
  return `otel/export/${backend}/${date}/${jobId}.json`;
}

export async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
