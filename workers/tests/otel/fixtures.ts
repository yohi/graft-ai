export const validTraceId = "00112233445566778899aabbccddeeff";
export const validSpanId = "0112233445566778";

export const validOtlpJson = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "ai-gateway" } },
          { key: "authorization", value: { stringValue: "Bearer resource-secret" } },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: validTraceId,
              spanId: validSpanId,
              name: "gateway.request",
              kind: "SPAN_KIND_SERVER",
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000000125000000",
              status: { code: "STATUS_CODE_OK", message: "" },
              attributes: [
                { key: "gen_ai.request.model", value: { stringValue: "smoke-model" } },
                { key: "gen_ai.model.provider", value: { stringValue: "smoke-provider" } },
                { key: "cf-aig-request-id", value: { stringValue: "request-1" } },
                { key: "http.response.status_code", value: { intValue: "200" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: "7" } },
                { key: "gen_ai.usage.total_tokens", value: { intValue: "19" } },
                { key: "gen_ai.usage.cost", value: { doubleValue: 0.0125 } },
                { key: "gateway", value: { stringValue: "main" } },
                { key: "env", value: { stringValue: "prod" } },
                {
                  key: "gen_ai.prompt_json",
                  value: { stringValue: '{"token":"sk-live-test-secret"}' },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
