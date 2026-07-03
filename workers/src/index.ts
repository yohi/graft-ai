import type { Env, AIGatewayLog, LokiPushPayload } from "./types";
import { importRsaPrivateKey, decryptIfEncrypted } from "./crypto";
import { transformNdjsonToLokiPayload } from "./transform";
import { pushToLoki } from "./loki";

// Cache imported RSA private keys across warm Worker invocations
const privateKeyCache = new Map<string, CryptoKey>();

function timingSafeSecretEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

async function getCachedPrivateKey(pem: string): Promise<CryptoKey> {
  let key = privateKeyCache.get(pem);
  if (!key) {
    key = await importRsaPrivateKey(pem);
    privateKeyCache.set(pem, key);
  }
  return key;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 1. Validate origin secret using constant-time comparison
    const originSecret = request.headers.get("X-Origin-Secret");
    if (!originSecret || !timingSafeSecretEqual(originSecret, env.ORIGIN_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 2. Decompress gzip body if Content-Encoding: gzip.
    //    Malformed gzip makes DecompressionStream throw a TypeError; if left
    //    uncaught the handler returns HTTP 500 and Logpush retries the same
    //    corrupt batch (~5x over 5 min). Return 400 to stop the retry loop.
    let bodyText: string;
    const contentEncoding = request.headers.get("Content-Encoding");
    if (contentEncoding === "gzip") {
      if (!request.body) {
        return new Response("Missing gzip body", { status: 400 });
      }
      try {
        const ds = new DecompressionStream("gzip");
        const decompressed = request.body.pipeThrough(ds);
        bodyText = await new Response(decompressed).text();
      } catch (err) {
        console.error(
          `Failed to decompress gzip body: ${err instanceof Error ? err.message : String(err)}`,
        );
        return new Response("Invalid gzip body", { status: 400 });
      }
    } else {
      bodyText = await request.text();
    }

    // 3. Import RSA private key (cached across warm Worker invocations)
    const privateKey = await getCachedPrivateKey(env.RSA_PRIVATE_KEY_PEM);

    // 4. Parse NDJSON, decrypt encrypted fields per line
    const lines = bodyText.split("\n").filter((line) => line.trim().length > 0);
    const decryptedLogs: AIGatewayLog[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        // Decrypt encrypted fields if present (Metadata, RequestBody, ResponseBody)
        const decrypted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(parsed)) {
          decrypted[key] = await decryptIfEncrypted(privateKey, value);
        }
        decryptedLogs.push(decrypted as unknown as AIGatewayLog);
      } catch (err) {
        console.error(
          `Failed to parse/decrypt log line: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // No log lines at all — nothing to process; acknowledge success so
    // Logpush does not retry an empty batch.
    if (lines.length === 0) {
      return new Response("No log lines", { status: 200 });
    }

    // Every line failed to parse/decrypt — the batch is unprocessable. Return
    // 4xx (not 5xx) so Logpush does not retry non-recoverable data, matching
    // the malformed-gzip handling above.
    if (decryptedLogs.length === 0) {
      return new Response("No valid log lines", { status: 400 });
    }

    // 5. Re-serialize to NDJSON and transform to Loki push payload
    //    (transformNdjsonToLokiPayload expects NDJSON string input)
    const decryptedNdjson = decryptedLogs.map((log) => JSON.stringify(log)).join("\n");
    const lokiPayload: LokiPushPayload = transformNdjsonToLokiPayload(
      decryptedNdjson,
      env.GATEWAY_NAME,
      env.ENV_LABEL,
    );

    if (lokiPayload.streams.length === 0) {
      return new Response("No transformable logs", { status: 200 });
    }

    // 6. Push to Loki
    const result = await pushToLoki(env, lokiPayload);

    if (result.ok) {
      return new Response("OK", { status: 200 });
    }

    // Return 503 to trigger Logpush retry for 5xx Loki responses
    // Return 400 for 4xx (non-429) Loki responses to avoid retry
    if (result.status >= 500 || result.status === 429) {
      return new Response(`Loki push failed: ${result.status}`, { status: 503 });
    }
    return new Response(`Loki push rejected: ${result.status}`, { status: 400 });
  },
} satisfies ExportedHandler<Env>;
