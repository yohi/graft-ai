import {
  RATE_LIMIT_CAPACITY,
  RATE_LIMIT_REFILL_PER_SECOND,
  RATE_LIMIT_RETRY_AFTER_MINIMUM_SECONDS,
} from "./contracts";

type BucketState = Readonly<{
  tokens: number;
  lastRefillMs: number;
}>;

export type RateLimitResult = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
}>;

export class OtelRateLimit {
  constructor(
    private readonly state: DurableObjectState,
    _env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/take") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body: unknown = await request.json();
    const input = parseTakeInput(body);
    const result = await this.take(input.nowMs);
    return Response.json(result);
  }

  async take(nowMs: number): Promise<RateLimitResult> {
    const current = (await this.state.storage.get<BucketState>("bucket")) ?? {
      tokens: RATE_LIMIT_CAPACITY,
      lastRefillMs: nowMs,
    };
    const elapsedSeconds = Math.max(0, nowMs - current.lastRefillMs) / 1_000;
    const tokens = Math.min(
      RATE_LIMIT_CAPACITY,
      current.tokens + elapsedSeconds * RATE_LIMIT_REFILL_PER_SECOND,
    );
    if (tokens >= 1) {
      await this.state.storage.put("bucket", {
        tokens: tokens - 1,
        lastRefillMs: nowMs,
      } satisfies BucketState);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    await this.state.storage.put("bucket", { tokens, lastRefillMs: nowMs } satisfies BucketState);
    const retryAfterSeconds = Math.max(
      RATE_LIMIT_RETRY_AFTER_MINIMUM_SECONDS,
      Math.ceil((1 - tokens) / RATE_LIMIT_REFILL_PER_SECOND),
    );
    return { allowed: false, retryAfterSeconds };
  }
}

function parseTakeInput(value: unknown): Readonly<{ nowMs: number }> {
  if (!isRecord(value) || typeof value["nowMs"] !== "number" || !Number.isFinite(value["nowMs"])) {
    throw new TypeError("invalid rate-limit request");
  }
  return { nowMs: value["nowMs"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
