# Operations

This document is the human-facing entry point for monitoring, recovery, quota handling, and operational checks.

## Monitoring

Use the observability backend appropriate to your deployment path:

- Tempo for traces.
- Loki for logs.
- Prometheus for metrics.
- Grafana for dashboards and cross-signal investigation.

The Free Tier local/self-hosted workflow is documented in [Free Tier AI Gateway + OTel](free-tier-ai-gateway-otel.md).

## Dedicated OTel Worker

Operational behavior for the dedicated Worker includes queue processing, payload-store cleanup, OTLP export, and failure classification.

The normative failure semantics and storage invariants are defined in [`../SPEC.md`](../SPEC.md). Deployment-specific commands are in [Dedicated Cloudflare Worker AI Gateway OTel](cloudflare-worker-ai-gateway-otel.md).

## Quotas and Limits

Cloudflare plan limits differ by deployment path. Do not infer production suitability from a successful development deployment.

The dedicated OTel Worker runbook contains the current measured constraints for production-size payloads. Re-check Cloudflare limits when changing Worker, Queue, D1, KV, or R2 usage.

## Recovery

When an observability path fails:

1. Confirm the proxy/AI request path separately from telemetry export.
2. Check Worker logs and queue status.
3. Verify the selected payload-store binding and credentials.
4. Verify OTLP endpoint reachability and authentication.
5. Apply rollback or migration procedures only after identifying which subsystem failed.

## Data Retention

Payload retention and cleanup behavior are normative technical contracts. See [`../SPEC.md`](../SPEC.md) rather than duplicating TTL or cleanup values here.

## Related Documentation

- [Configuration](configuration.md)
- [Deployment](deployment.md)
- [Migration](migration.md)
- [Dedicated Cloudflare Worker AI Gateway OTel](cloudflare-worker-ai-gateway-otel.md)
