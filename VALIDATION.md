# Validation obligations

The scaffold supplies generic package/release validation and regression fixtures. Add domain-specific tests and regressions.

Capability regressions should prove bounded amendments of healthy authoritative artifacts, deep-path escalation, preservation of unrelated valid artifacts/evidence, targeted invalidation/revalidation, and independent gate ownership. Assert semantic obligations or observable behavior rather than rigid prose sentences unless exact wording is the contract. Adapt these cases to the capability; do not embed provider-specific policy in generic package validation.

Report reusable durable execution/observation evidence, invalidated evidence, freshly established evidence, and assumptions/inferences that are not evidence. Independently inspect reused evidence and rerun affected checks plus mandatory invariants when changes invalidate it. This refinement does not reduce the formal gates below.

Under the simplified archive-integrity contract, `CHECKSUMS.sha256` is not a required source or release artifact. The checksum scripts remain optional maintenance diagnostics, not release gates.

Managed clean-Linux parity is container-engine neutral. `docker` is the default CLI for compatibility; set `WOIA_CONTAINER_ENGINE=podman` (or another Docker-compatible local OCI CLI) to use a zero-cost alternative. Hosted or paid container services are not mandatory.

For repository setup and local gates, follow [Repository maintenance](docs/MAINTENANCE.md).
For exact-candidate certification and publication, follow [Release](docs/RELEASE.md).

Also run `skills-ref validate` for each skill when available.

No placeholder token or scaffold-only `README.plugin.md` may remain in the release candidate.


## B4 global-contract regressions

Run `node --test tests/b4-global-runtime.test.mjs` (also included by `pnpm test` / `ci:fast`). The regression must prove fenced Due Work, no blind retry after unknown transport, receiver-owned Task acceptance, purpose-scoped resource resolution, and fail-closed exact base/delta/provider-closure composition. Schema validation must include the five B4 linked schemas through the Core manifest. Real host transport/activation and production durable-store behavior remain later integration/operator evidence; unit regressions must not be relabeled as host E2E.
