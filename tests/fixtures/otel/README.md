# OTel fixtures

This directory contains documentation for sanitized OTel acceptance fixtures.

- No raw OTLP payloads, credentials, account identifiers, source addresses, or
  backend URLs are stored here.
- Go ingress tests generate deterministic protobuf and JSON payloads in memory.
- Shared receiver, limit, source-identity, and retention contracts live in
  `deploy/otel/contracts/contracts.json`.
- Real-account evidence is stored under `docs/superpowers/acceptance/` and
  records only status codes, endpoint shapes, and safe trace identifiers.
