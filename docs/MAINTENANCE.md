# Repository maintenance

This document describes the source-repository authoring environment. It is not a consumer requirement.

Canonical maintenance versions live in `package.json` and are mirrored/verified by Mise.

`pnpm-workspace.yaml` must retain:

~~~yaml
verifyDepsBeforeRun: error
~~~

## Setup

~~~text
mise install
mise run bootstrap
~~~

## Daily validation

~~~text
mise run doctor
mise run ci:fast
~~~

The fast gate includes `scripts/tests/runtime-lifecycle.test.mjs`: exact specialization pins, scoped descriptor and policy resolution, generation invalidation, update CAS, concurrent bootstrap/update, overlay preservation, pending effects and current-session local-write checks. Focused execution uses `mise exec -- node --test scripts/tests/runtime-lifecycle.test.mjs`. Set `WOIA_TEST_TMP` to the authorized temporary workspace when the host requires one; fixtures are synthetic and never qualify a provider or actual host session.

## Portability validation

~~~text
mise run ci:extended
mise run jobs:local
~~~

Container parity uses a read-only source mount, a fresh Linux workspace, an exact pnpm install and frozen dependencies. `docker` is the compatibility-default CLI; set `WOIA_CONTAINER_ENGINE=podman` (or another Docker-compatible local OCI CLI) to use a zero-cost alternative. Hosted/paid container services are not required.

## Portable payload changes

~~~text
# optional source diagnostic; not a release gate
pnpm run checksums:generate
mise run ci:fast
~~~
