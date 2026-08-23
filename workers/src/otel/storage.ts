import type { Backend } from "./contracts";
import type { ObjectPointer } from "./types";

export async function putJsonObject<T>(
  bucket: R2Bucket,
  objectKey: string,
  value: T,
): Promise<ObjectPointer> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return putBytesObject(
    bucket,
    objectKey,
    bytes,
    objectKey.includes("/export/") ? "export" : "ingress",
  );
}

export async function putBytesObject(
  bucket: R2Bucket,
  objectKey: string,
  bytes: Uint8Array,
  kind: "ingress" | "export",
): Promise<ObjectPointer> {
  const sha256 = await sha256Hex(bytes);
  const id =
    objectKey
      .split("/")
      .pop()
      ?.replace(/\.json$/, "") ?? objectKey;
  await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { schemaVersion: "1", sha256, kind },
  });
  return {
    schemaVersion: 1,
    id,
    objectKey,
    sha256,
    contentType: "application/json",
    createdAtMs: Date.now(),
  };
}

export async function readJsonObject<T>(bucket: R2Bucket, pointer: ObjectPointer): Promise<T> {
  const bytes = await readBytesObject(bucket, pointer);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return parsed as T;
}

export async function readBytesObject(
  bucket: R2Bucket,
  pointer: ObjectPointer,
): Promise<Uint8Array> {
  const object = await bucket.get(pointer.objectKey);
  if (!object) throw new Error("R2 object missing");
  const contentType = object.httpMetadata?.contentType;
  if (contentType !== pointer.contentType) throw new Error("R2 object content type mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== pointer.sha256) throw new Error("R2 object checksum mismatch");
  if (object.customMetadata?.sha256 !== pointer.sha256)
    throw new Error("R2 object metadata mismatch");
  return bytes;
}

export async function deleteJsonObject(bucket: R2Bucket, pointer: ObjectPointer): Promise<void> {
  await bucket.delete(pointer.objectKey);
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
