import { HttpTransportError, type HttpTransportErrorKind } from "../../http-retry";

function errorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name;
  if (typeof error !== "object" || error === null || !("name" in error)) return undefined;

  const name = error.name;
  return typeof name === "string" ? name : undefined;
}

export function classifyOllamaTransportError(error: unknown): HttpTransportErrorKind | undefined {
  if (error instanceof HttpTransportError) return error.kind;
  if (error instanceof TypeError) return "network";

  const name = errorName(error);
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  return undefined;
}
