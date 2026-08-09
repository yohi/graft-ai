import type { OllamaCloudEnv } from "./types";
import { computeReset } from "./ollama-cloud/calc";
import { pushMetrics } from "./ollama-cloud/prometheus";

const DEFAULT_SESSION_INTERVAL_SECONDS = 18000;
const DEFAULT_WEEKLY_INTERVAL_SECONDS = 604800;

function parseInterval(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid interval: ${value}`);
  }
  return parsed;
}

function parseAnchorIso(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
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

    const anchorMs = parseAnchorIso(anchorIso);
    if (anchorMs === null) {
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
