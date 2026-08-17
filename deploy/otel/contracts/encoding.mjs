const CONTENT_TYPES = Object.freeze({
  protobuf: "application/x-protobuf",
  json: "application/json",
});

export function resolveOtelEncoding(env = process.env) {
  const encoding = env.CLOUDFLARE_OTEL_EXPORT_ENCODING;
  if (encoding === "protobuf" || encoding === "json") {
    return encoding;
  }

  throw new Error(
    "CLOUDFLARE_OTEL_EXPORT_ENCODING must be set to protobuf or json",
  );
}

export function contentTypeForOtelEncoding(encoding) {
  const contentType = CONTENT_TYPES[encoding];
  if (contentType === undefined) {
    throw new Error("OTEL encoding must be protobuf or json");
  }
  return contentType;
}

export const otelContentTypes = CONTENT_TYPES;
