<!-- markdownlint-disable MD013 -->

# AI Gateway OTel Feasibility Gate

Date: 2026-08-17

## Decision

**PASS.** The Cloudflare AI Gateway Free Plan exporter was configured with the
protobuf encoding and delivered a request-associated span through the
`/v1/traces` Tunnel path. The implementation proceeds with custom Alloy as the
sole owner of bounded ingress, redaction, fan-out, and backend dispatch. No
separate dispatcher image is required.

## Sanitized environment

- Encoding: `CLOUDFLARE_OTEL_EXPORT_ENCODING=protobuf`
- Export content type: `application/x-protobuf`
- Receiver path: `/v1/traces`
- Cloudflare gateway: `my-gateway`
- Cloudflare API operation shape: `PUT /accounts/<account-id>/ai-gateway/gateways/<gateway-id>`
- Grafana OTLP endpoint shape: `https://otlp-gateway-<region>.grafana.net/otlp/v1/traces`
- Tunnel endpoint shape: `https://<temporary-quick-tunnel-host>/v1/traces`
- cloudflared version: `2026.8.2`

Temporary tokens, account identifiers, hostnames, request payloads, headers,
source addresses, and backend credentials are intentionally omitted.

## Evidence

| Check | Result |
| --- | --- |
| Free Plan exporter configuration | HTTP 200 from the sanitized gateway configuration operation |
| Direct AI Gateway request | HTTP 200; request-associated Tempo trace found |
| Proxy Worker request | HTTP 200; request-associated Tempo trace found |
| Export encoding | `application/x-protobuf` |
| Tunnel path preservation | `/v1/traces` reached the receiver |
| Trace identifiers | Direct trace `33445566778899aabbccddeeff001122`; proxy trace `ddeeff00112233445566778899aabbcc` with span `c4a302f59689694d` |
| Payload safety | No payload or credential data recorded in this evidence |

The temporary receiver and Quick Tunnel were stopped after the check. The
Grafana exporter configuration was restored to one exporter after the test.

## Hard-stop evaluation

The Free Plan account accepted the exporter configuration and delivered real
protobuf spans for both direct and proxy request paths. The required OTel path
is therefore feasible without replacing it with Logpush, paid-only features,
or a mandatory proxy route.
