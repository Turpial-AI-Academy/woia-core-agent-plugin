## Change

Describe the capability or authoring change.

## Validation

- [ ] placeholders are not present in candidate files
- [ ] `pnpm run checksums:generate` run when portable payload changed
- [ ] `mise run ci:fast` passes
- [ ] `mise run ci:extended` / `jobs:local` run when portability behavior changed
- [ ] version/changelog impact evaluated
- [ ] no repository-specific rule was accidentally made universal
- [ ] consumer capability remains independent from authoring tooling
