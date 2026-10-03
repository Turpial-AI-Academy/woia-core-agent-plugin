# Security

- Never store credentials/secrets in .woia state, overlays, plugin files or execution receipts.
- Technical plugin/tool access never implies business authority.
- Effectful operations require the effective department/organization authorization path.
- Unknown external effects must be reconciled before retry.
- Cross-session state must not depend on hidden chain-of-thought or provider cache.
- Project overlays may contain Project instructions/preferences, not reusable credentials.
