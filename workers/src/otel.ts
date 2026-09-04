import { OtelLedger } from "./otel/ledger";
import { OtelMetricsAggregate } from "./otel/metrics-aggregate";
import { OtelRateLimit } from "./otel/rate-limit";
import { TraceAggregate } from "./otel/trace-aggregate";
import { handleIngress } from "./otel/ingress";
import { handleQueue } from "./otel/queue";
import { D1PayloadStore } from "./otel/storage";
import type { OtelEnv, QueuePointer } from "./otel/types";

export { OtelLedger, OtelMetricsAggregate, OtelRateLimit, TraceAggregate };
export { handleIngress, handleQueue };

export default {
  async fetch(request: Request, env: OtelEnv): Promise<Response> {
    return handleIngress(request, env);
  },
  async queue(
    batch: MessageBatch<QueuePointer>,
    env: OtelEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    return handleQueue(batch, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: OtelEnv, _ctx: ExecutionContext): Promise<void> {
    if (env.OTEL_PAYLOAD_D1) {
      try {
        const store = new D1PayloadStore(env.OTEL_PAYLOAD_D1);
        const changes = await store.deleteExpired(Math.floor(Date.now() / 1000));
        console.log(`[D1 Purge] Removed ${changes} expired payload records`);
      } catch (error) {
        console.error("[D1 Purge] Scheduled purge error:", error);
        throw error;
      }
    }
  },
};
