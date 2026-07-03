export interface Env {
  GRAFANA_CLOUD_LOKI_URL: string;
  GRAFANA_CLOUD_LOKI_USERNAME: string;
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: string;
  ORIGIN_SECRET: string;
  RSA_PRIVATE_KEY_PEM: string;
  GATEWAY_NAME: string;
  ENV_LABEL: string;
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
