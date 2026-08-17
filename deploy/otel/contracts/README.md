# OTel contracts

This directory contains dependency-free JSON contracts shared by the Node.js
contract tests and the custom Alloy Go implementation.

- `encoding.mjs` validates the Cloudflare exporter encoding selection.
- `contracts.json` defines receiver responses, limits, canonical metrics, labels,
  and fail-closed Cloud Logs retention behavior.
- `sampling-fixtures.json` fixes the SHA-256 seed, decimal-to-ppm rates, hash
  prefixes, and exact sampling decisions used by both implementations.

The fixtures contain no endpoints, credentials, payloads, or machine-specific
paths. Changes to these values are contract changes and must update the Node.js
tests and downstream Go tests together.
