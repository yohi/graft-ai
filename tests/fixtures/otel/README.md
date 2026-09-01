# OTel fixtures

This directory contains documentation for sanitized OTel acceptance fixtures.

- No raw OTLP payloads, credentials, account identifiers, source addresses, or
  backend URLs are stored here.
- Go ingress tests generate deterministic protobuf and JSON payloads in memory.
- Shared receiver, limit, source-identity, and retention contracts live in
  `deploy/otel/contracts/contracts.json`.
- Real-account acceptance evidence (sanitized status codes, endpoint shapes,
  and trace identifiers only) was recorded during the 2026-08-17 feasibility
  gate and removed with the design archive; see git history for details.
