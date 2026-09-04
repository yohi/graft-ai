# OTel Review Fixes Design

## Scope

Apply the accepted review findings for the dedicated Cloudflare Worker OTel
pipeline without changing the D1 migration procedure:

- Keep the OTel runbook in the repository root after the Wrangler migration
  command.
- Document the Workers Free D1 account and per-database storage limits.
- Describe `delaySeconds: 0` as the absence of an intentional Queue delay, not
  as an end-to-end immediate-delivery guarantee.
- Document the D1 payload byte limit, its relationship to the export cap, and
  the resulting ingress and export behavior.
- Return HTTP 413 for an oversized D1 ingress payload only when its ingress
  reservation was released successfully; return HTTP 503 when release fails.

## Error Handling Decision

The ingress path will attempt `releaseReservation` once. A successful release
preserves the existing HTTP 413 response for `PayloadStorePayloadTooLargeError`.
A `false` result or an exception from the release call returns HTTP 503 instead,
so the reservation failure is not hidden. No retry loop is added in this change.

## Documentation Updates

Update the English and Japanese README sections, both SPEC files, and the OTel
runbook with the verified D1 and Queue semantics. The existing migration
command and surrounding migration instructions remain unchanged except for
wrapping the standalone Wrangler command in a subshell so the following Make
command runs from the repository root.

## Verification

Add a regression test for both reservation-release outcomes in the ingress
payload-too-large path. Run the repository's required Worker tests, typecheck,
format checks, and validation checks as available, then inspect the final diff
before committing and pushing the changes.

## Non-goals

- Do not change the D1 schema or migration SQL.
- Do not change Queue retry, batching, or consumer configuration.
- Do not add a release retry policy.
- Do not modify unrelated documentation or source files.
