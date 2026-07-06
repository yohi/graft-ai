import type { OllamaCloudEnv } from "./types";
import { computeReset } from "./ollama-cloud/calc";
import { pushMetrics } from "./ollama-cloud/prometheus";

const DEFAULT_SESSION_INTERVAL_SECONDS = 18000;
const DEFAULT_WEEKLY_INTERVAL_SECONDS = 604800;

function parseInterval(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid interval: ${value}`);
  }
  return parsed;
}

export interface OllamaCloudWorker {
  scheduled(event: ScheduledEvent, env: OllamaCloudEnv, ctx: ExecutionContext): Promise<void>;
}

const worker: OllamaCloudWorker = {
  async scheduled(event, env, _ctx) {
    const anchorIso = env.OLLAMA_CLOUD_RESET_ANCHOR_ISO;
    if (!anchorIso) {
      console.error("OLLAMA_CLOUD_RESET_ANCHOR_ISO is not configured");
      return;
    }

    const anchorMs = Date.parse(anchorIso);
    if (Number.isNaN(anchorMs)) {
      console.error(`Invalid OLLAMA_CLOUD_RESET_ANCHOR_ISO: ${anchorIso}`);
      return;
    }

    const anchorSeconds = Math.floor(anchorMs / 1000);
    const nowSeconds = Math.floor(event.scheduledTime / 1000);

    let sessionInterval: number;
    let weeklyInterval: number;
    try {
      sessionInterval = parseInterval(
        env.OLLAMA_CLOUD_SESSION_INTERVAL_SECONDS,
        DEFAULT_SESSION_INTERVAL_SECONDS,
      );
      weeklyInterval = parseInterval(
        env.OLLAMA_CLOUD_WEEKLY_INTERVAL_SECONDS,
        DEFAULT_WEEKLY_INTERVAL_SECONDS,
      );
    } catch (err) {
      console.error(
        `Invalid Ollama Cloud interval configuration: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const calculations = [
      computeReset(nowSeconds, anchorSeconds, sessionInterval, "session"),
      computeReset(nowSeconds, anchorSeconds, weeklyInterval, "weekly"),
    ];

    const plan = env.OLLAMA_CLOUD_PLAN ?? "unknown";
    const result = await pushMetrics(env, calculations, plan);
    if (!result.ok) {
      console.error(`Failed to push Ollama Cloud metrics: status=${result.status}`);
    }
  },
};

export default worker;
