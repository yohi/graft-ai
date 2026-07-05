export interface Env {
  GRAFANA_CLOUD_LOKI_URL: string;
  GRAFANA_CLOUD_LOKI_USERNAME: string;
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: string;
  ORIGIN_SECRET?: string;
  RSA_PRIVATE_KEY_PEM?: string;
  GATEWAY_NAME: string;
  ENV_LABEL: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  INCLUDE_REQUEST_BODY?: string; // "true" to include decrypted request body
  INCLUDE_RESPONSE_BODY?: string; // "true" to include decrypted response body
  INCLUDE_METADATA?: string; // "true" to include decrypted metadata
}

export interface TelemetryEvent {
  _graft_ai_telemetry: true;
  request_id: string;
  timestamp: string;
  model: string;
  status_code: number;
  cache_status: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms: number;
  path: string;
  method: string;
  gateway: string;
  env: string;
}

export interface AIGatewayLog {
  RequestID: string;
  RequestTime: number;
  CacheStatus: string;
  StatusCode: number;
  Model: string;
  PromptTokens: number;
  CompletionTokens: number;
  TotalTokens: number;
  RequestDuration: number;
  Path: string;
  Method: string;
  RequestHeaders?: Record<string, string>;
  ResponseHeaders?: Record<string, string>;
  Metadata?: EncryptedField;
  RequestBody?: EncryptedField;
  ResponseBody?: EncryptedField;
  [key: string]: unknown;
}

export interface EncryptedField {
  key: string;
  iv: string;
  data: string;
}

export function isEncryptedField(value: unknown): value is EncryptedField {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const v = value as Record<string, unknown>;
  if (typeof v.key !== "string" || typeof v.iv !== "string" || typeof v.data !== "string") {
    return false;
  }

  const key = v.key;
  const iv = v.iv;
  const data = v.data;

  const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

  return (
    key.length > 0 &&
    iv.length > 0 &&
    data.length > 0 &&
    base64Pattern.test(key) &&
    base64Pattern.test(iv) &&
    base64Pattern.test(data)
  );
}

export interface LokiStream {
  stream: {
    model: string;
    status_code: string;
    env: string;
    gateway: string;
  };
  values: [string, string][];
}

export interface LokiPushPayload {
  streams: LokiStream[];
}
