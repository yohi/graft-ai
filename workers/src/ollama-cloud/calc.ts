export interface ResetCalculation {
  period: "session" | "weekly";
  intervalSeconds: number;
  nextResetTimestampSeconds: number;
  remainingSeconds: number;
  progressRatio: number;
}

export function computeReset(
  nowSeconds: number,
  anchorSeconds: number,
  intervalSeconds: number,
  period: "session" | "weekly",
): ResetCalculation {
  if (intervalSeconds <= 0) {
    throw new Error(`intervalSeconds must be positive, got ${intervalSeconds}`);
  }
  const elapsed = nowSeconds - anchorSeconds;
  const remainder = ((elapsed % intervalSeconds) + intervalSeconds) % intervalSeconds;
  const progressRatio = remainder / intervalSeconds;
  const remainingSeconds = intervalSeconds - remainder;
  const nextResetTimestampSeconds = nowSeconds + remainingSeconds;
  return {
    period,
    intervalSeconds,
    nextResetTimestampSeconds,
    remainingSeconds,
    progressRatio,
  };
}
