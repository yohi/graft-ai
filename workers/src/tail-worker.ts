import { pushToLoki } from "./loki";
import {
  transformLogToLokiStream,
  logMessageToTelemetry,
  telemetryToAIGatewayLog,
} from "./transform";
import type { TailEnv, LokiPushPayload, LokiStream } from "./types";

export default {
  async tail(events: TraceItem[], env: TailEnv, _ctx: ExecutionContext): Promise<void> {
    const payload: LokiPushPayload = { streams: [] };
    const streamMap = new Map<string, LokiStream>();
    for (const event of events) {
      for (const log of event.logs) {
        const telemetry = logMessageToTelemetry(log.message);
        if (telemetry) {
          const stream = transformLogToLokiStream(
            telemetryToAIGatewayLog(telemetry),
            telemetry.gateway,
            telemetry.env,
          );
          const key = `${stream.stream.model}|${stream.stream.status_code}|${stream.stream.env}|${stream.stream.gateway}`;
          const existing = streamMap.get(key);
          if (existing) {
            existing.values.push(...stream.values);
          } else {
            streamMap.set(key, stream);
          }
        }
      }
    }

    payload.streams.push(...streamMap.values());
    for (const stream of payload.streams) {
      stream.values.sort((a, b) => {
        const aTime = BigInt(a[0]);
        const bTime = BigInt(b[0]);
        return aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
      });
    }
    if (payload.streams.length === 0) {
      return;
    }

    const result = await pushToLoki(env, payload);
    if (!result.ok) {
      console.error(`Tail Worker Loki push failed: ${result.status}`);
    }
  },
} satisfies ExportedHandler<TailEnv>;
