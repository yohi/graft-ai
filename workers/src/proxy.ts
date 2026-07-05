import type { ProxyEnv, TelemetryEvent } from "./types";

const AI_GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com";
const TOKEN_PAIR_PATTERN = /(?:^|[,\s])([^=,\s]+)=(\d+)/g;

async function timingSafeSecretEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  const aPadded = new Uint8Array(maxLen);
  const bPadded = new Uint8Array(maxLen);
  aPadded.set(aBytes);
  bPadded.set(bBytes);
  return crypto.subtle.timingSafeEqual(aPadded, bPadded) && aBytes.length === bBytes.length;
}

type TokenCounts = {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
};

function requireProxyConfig(env: ProxyEnv): {
  readonly accountId: string;
  readonly gatewayId: string;
} {
  if (!env.CF_ACCOUNT_ID || !env.AI_GATEWAY_ID) {
    throw new Error("CF_ACCOUNT_ID and AI_GATEWAY_ID are required for proxy mode");
  }
  return { accountId: env.CF_ACCOUNT_ID, gatewayId: env.AI_GATEWAY_ID };
}

function buildGatewayUrl(requestUrl: string, env: ProxyEnv): string {
  const { accountId, gatewayId } = requireProxyConfig(env);
  const url = new URL(requestUrl);
  const path = url.pathname.replace(/^\/+/, "");
  const gatewayUrl = new URL(`${AI_GATEWAY_ORIGIN}/v1/${accountId}/${gatewayId}/`);
  gatewayUrl.pathname += path;
  gatewayUrl.search = url.search;
  return gatewayUrl.toString();
}

function parseNumberHeader(headers: Headers, name: string): number {
  const value = headers.get(name);
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTokenHeader(headers: Headers): TokenCounts {
  const raw = headers.get("cf-aig-tokens");
  if (!raw) {
    return { prompt: 0, completion: 0, total: 0 };
  }

  let prompt = 0;
  let completion = 0;
  let total = 0;
  for (const match of raw.matchAll(TOKEN_PAIR_PATTERN)) {
    const key = match[1];
    const value = Number(match[2]);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (key === "prompt" || key === "prompt_tokens") {
      prompt = value;
    } else if (key === "completion" || key === "completion_tokens") {
      completion = value;
    } else if (key === "total" || key === "total_tokens") {
      total = value;
    }
  }

  return { prompt, completion, total: total > 0 ? total : prompt + completion };
}

function buildTelemetryEvent(
  request: Request,
  response: Response,
  env: ProxyEnv,
  durationMs: number,
): TelemetryEvent {
  const url = new URL(request.url);
  const tokens = parseTokenHeader(response.headers);
  return {
    _graft_ai_telemetry: true,
    request_id: response.headers.get("cf-aig-request-id") ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    model: response.headers.get("cf-aig-model") ?? "unknown",
    status_code: response.status,
    cache_status: response.headers.get("cf-aig-cache-status") ?? "unknown",
    prompt_tokens: tokens.prompt,
    completion_tokens: tokens.completion,
    total_tokens: tokens.total,
    // If cf-aig-duration-ms is absent, durationMs is time-to-headers only, which
    // may under-report the true latency for streaming responses.
    duration_ms: parseNumberHeader(response.headers, "cf-aig-duration-ms") || durationMs,
    path: url.pathname,
    method: request.method,
    gateway: env.GATEWAY_NAME,
    env: env.ENV_LABEL,
  };
}

function buildUpstreamInit(request: Request): RequestInit {
  const headers = new Headers(request.headers);
  headers.delete("X-Proxy-Secret");
  if (request.method === "GET" || request.method === "HEAD") {
    return { method: request.method, headers, redirect: "manual" };
  }
  return {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    duplex: "half",
  } as RequestInit;
}

export default {
  async fetch(request: Request, env: ProxyEnv, _ctx: ExecutionContext): Promise<Response> {
    // Validate proxy secret using constant-time comparison
    const proxySecret = request.headers.get("X-Proxy-Secret");
    if (!proxySecret || !(await timingSafeSecretEqual(proxySecret, env.PROXY_SECRET ?? ""))) {
      return new Response("Unauthorized", { status: 401 });
    }

    // NOTE: For streaming (SSE / chunked) responses this measures time-to-first-byte.
    // The full stream completion time is only available when the gateway returns
    // cf-aig-duration-ms, which is preferred below (see parseNumberHeader fallback).
    let upstreamUrl: string;
    try {
      upstreamUrl = buildGatewayUrl(request.url, env);
    } catch (err) {
      console.error(
        `Proxy configuration error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return new Response(
        JSON.stringify({
          error: "Proxy misconfigured",
          message: "CF_ACCOUNT_ID and AI_GATEWAY_ID are required",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    const startedAt = Date.now();
    const upstreamResponse = await fetch(upstreamUrl, buildUpstreamInit(request));
    const durationMs = Date.now() - startedAt;
    console.log(JSON.stringify(buildTelemetryEvent(request, upstreamResponse, env, durationMs)));
    return upstreamResponse;
  },
} satisfies ExportedHandler<ProxyEnv>;
