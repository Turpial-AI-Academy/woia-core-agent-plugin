# Release

Core's current distribution version is `0.5.7`. Public plugin identity is `woia-core`.

Authorized maintainers prepare a release from an exact clean commit using Node 24.21.0 and pnpm 11.19.0:

```text
mise run doctor
mise run ci:fast
mise run release:check
```

`ci:fast` checks plugin metadata, portable payload safety, Core schema compilation, workflow profiles, deterministic script syntax and distributed checksums. `release:check` additionally checks candidate identity, version consistency, Git whitespace and the exact portable archive contents.

Certify and publish through the current Ecosystem Factory flow, preserving the candidate SHA. Verify the new tag, final Release, downloadable assets and SHA-256 values before admitting the release and regenerating marketplace pins. Publication requires the repository's maintainer authorization and effective GitHub protections.

Published tags and Releases remain immutable. Corrections use a new version. Runtime protocol schema identifiers remain stable unless their contracts require an explicit protocol migration.
