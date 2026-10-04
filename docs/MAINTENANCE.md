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
