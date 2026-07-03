import { describe, it, expect } from "vitest";
import {
  normalizeModelName,
  requestTimeToNanos,
  buildLogLine,
  transformLogToLokiStream,
  transformNdjsonToLokiPayload,
} from "../src/transform";
import type { AIGatewayLog } from "../src/types";

describe("normalizeModelName", () => {
  it("strips @cf/meta/ prefix", () => {
    expect(normalizeModelName("@cf/meta/llama-3.1-8b-instruct")).toBe("llama-3.1-8b-instruct");
  });

  it("strips @cf/ prefix with multi-segment scope", () => {
    expect(normalizeModelName("@cf/openai/gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("returns name as-is when no @cf/ prefix", () => {
    expect(normalizeModelName("gpt-4o")).toBe("gpt-4o");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeModelName("")).toBe("");
  });
});

describe("requestTimeToNanos", () => {
  it("converts seconds (10-digit epoch) to nanoseconds", () => {
    expect(requestTimeToNanos(1720032000)).toBe("1720032000000000000");
  });

  it("converts milliseconds (13-digit epoch) to nanoseconds", () => {
    expect(requestTimeToNanos(1720032000000)).toBe("1720032000000000000");
  });

  it("handles 0 as seconds", () => {
    expect(requestTimeToNanos(0)).toBe("0");
  });
});

describe("buildLogLine", () => {
  it("builds JSON log line with selected fields in snake_case", () => {
    const log: AIGatewayLog = {
      RequestID: "abc123",
      RequestTime: 1720032000,
      CacheStatus: "miss",
      StatusCode: 200,
      Model: "@cf/meta/llama-3.1-8b-instruct",
      PromptTokens: 150,
      CompletionTokens: 80,
      TotalTokens: 230,
      RequestDuration: 1250,
      Path: "/v1/chat/completions",
      Method: "POST",
      RequestHeaders: { Authorization: "Bearer secret" },
      ResponseHeaders: { "X-Trace": "abc" },
    };
    const line = buildLogLine(log);
    const parsed = JSON.parse(line);
    expect(parsed.request_id).toBe("abc123");
    expect(parsed.cache_status).toBe("miss");
    expect(parsed.prompt_tokens).toBe(150);
    expect(parsed.completion_tokens).toBe(80);
    expect(parsed.total_tokens).toBe(230);
    expect(parsed.duration_ms).toBe(1250);
    expect(parsed.path).toBe("/v1/chat/completions");
    expect(parsed.method).toBe("POST");
    // Sensitive fields must NOT be present
    expect(parsed.RequestHeaders).toBeUndefined();
    expect(parsed.ResponseHeaders).toBeUndefined();
    expect(parsed.authorization).toBeUndefined();
  });
});

describe("transformLogToLokiStream", () => {
  it("creates a Loki stream with correct labels and values", () => {
    const log: AIGatewayLog = {
      RequestID: "req-001",
      RequestTime: 1720032000,
      CacheStatus: "miss",
      StatusCode: 200,
      Model: "@cf/meta/llama-3.1-8b-instruct",
      PromptTokens: 150,
      CompletionTokens: 80,
      TotalTokens: 230,
      RequestDuration: 1250,
      Path: "/v1/chat/completions",
      Method: "POST",
    };
    const stream = transformLogToLokiStream(log, "main", "prod");
    expect(stream.stream.model).toBe("llama-3.1-8b-instruct");
    expect(stream.stream.status_code).toBe("200");
    expect(stream.stream.env).toBe("prod");
    expect(stream.stream.gateway).toBe("main");
    expect(stream.values).toHaveLength(1);
    expect(stream.values[0]![0]).toBe("1720032000000000000");
    const logLine = JSON.parse(stream.values[0]![1]);
    expect(logLine.request_id).toBe("req-001");
  });

  it("uses 400 status code in label", () => {
    const log: AIGatewayLog = {
      RequestID: "req-003",
      RequestTime: 1720032120,
      CacheStatus: "miss",
      StatusCode: 400,
      Model: "@cf/meta/llama-3.1-8b-instruct",
      PromptTokens: 10,
      CompletionTokens: 0,
      TotalTokens: 10,
      RequestDuration: 100,
      Path: "/v1/chat/completions",
      Method: "POST",
    };
    const stream = transformLogToLokiStream(log, "main", "prod");
    expect(stream.stream.status_code).toBe("400");
  });
});

describe("transformNdjsonToLokiPayload", () => {
  it("groups log lines with identical labels into one stream", () => {
    const ndjson = [
      JSON.stringify({
        RequestID: "req-001",
        RequestTime: 1720032000,
        CacheStatus: "miss",
        StatusCode: 200,
        Model: "@cf/meta/llama-3.1-8b-instruct",
        PromptTokens: 150,
        CompletionTokens: 80,
        TotalTokens: 230,
        RequestDuration: 1250,
        Path: "/v1/chat/completions",
        Method: "POST",
      }),
      JSON.stringify({
        RequestID: "req-002",
        RequestTime: 1720032060,
        CacheStatus: "hit",
        StatusCode: 200,
        Model: "@cf/meta/llama-3.1-8b-instruct",
        PromptTokens: 200,
        CompletionTokens: 120,
        TotalTokens: 420,
        RequestDuration: 50,
        Path: "/v1/chat/completions",
        Method: "POST",
      }),
    ].join("\n");

    const payload = transformNdjsonToLokiPayload(ndjson, "main", "prod");
    expect(payload.streams).toHaveLength(1);
    expect(payload.streams[0]!.values).toHaveLength(2);
    expect(payload.streams[0]!.stream.model).toBe("llama-3.1-8b-instruct");
    expect(payload.streams[0]!.stream.status_code).toBe("200");
  });

  it("creates separate streams for different label combinations", () => {
    const ndjson = [
      JSON.stringify({
        RequestID: "req-001",
        RequestTime: 1720032000,
        CacheStatus: "miss",
        StatusCode: 200,
        Model: "@cf/meta/llama-3.1-8b-instruct",
        PromptTokens: 150,
        CompletionTokens: 80,
        TotalTokens: 230,
        RequestDuration: 1250,
        Path: "/v1/chat/completions",
        Method: "POST",
      }),
      JSON.stringify({
        RequestID: "req-004",
        RequestTime: 1720032180,
        CacheStatus: "miss",
        StatusCode: 500,
        Model: "@cf/meta/llama-3.1-70b-instruct",
        PromptTokens: 300,
        CompletionTokens: 0,
        TotalTokens: 300,
        RequestDuration: 5000,
        Path: "/v1/chat/completions",
        Method: "POST",
      }),
    ].join("\n");

    const payload = transformNdjsonToLokiPayload(ndjson, "main", "prod");
    expect(payload.streams).toHaveLength(2);
  });

  it("skips invalid JSON lines and continues", () => {
    const ndjson = [
      "this is not json",
      JSON.stringify({
        RequestID: "req-001",
        RequestTime: 1720032000,
        CacheStatus: "miss",
        StatusCode: 200,
        Model: "@cf/meta/llama-3.1-8b-instruct",
        PromptTokens: 150,
        CompletionTokens: 80,
        TotalTokens: 230,
        RequestDuration: 1250,
        Path: "/v1/chat/completions",
        Method: "POST",
      }),
    ].join("\n");

    const payload = transformNdjsonToLokiPayload(ndjson, "main", "prod");
    expect(payload.streams).toHaveLength(1);
    expect(payload.streams[0]!.values).toHaveLength(1);
  });

  it("handles empty input", () => {
    const payload = transformNdjsonToLokiPayload("", "main", "prod");
    expect(payload.streams).toHaveLength(0);
  });
});
