import { OtelLedger } from "./otel/ledger";
import { OtelMetricsAggregate } from "./otel/metrics-aggregate";
import { OtelRateLimit } from "./otel/rate-limit";
import { TraceAggregate } from "./otel/trace-aggregate";
import { handleIngress } from "./otel/ingress";
import { handleQueue } from "./otel/queue";
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
};
