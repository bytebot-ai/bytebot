# Changelog

All notable changes are documented here.

## 2025-09-11

### Fixed
- Resolved Prisma WASM engine error during `bytebot-agent` Docker build and runtime.

### Changes
- `packages/bytebot-agent/package.json`
  - Pin `@prisma/client` to `6.6.0` (no caret).
  - Add `prisma` at `6.6.0` and use local `prisma` binary in scripts (no `npx`).
- `packages/bytebot-agent/prisma/schema.prisma`
  - Set `engineType = "library"` in the Prisma client generator to force the Node-API engine.
- `packages/bytebot-agent/Dockerfile`
  - Switch base image to `node:20-bookworm-slim`.
  - Install `openssl` and `ca-certificates`.
  - Set `PRISMA_CLIENT_ENGINE_TYPE=library` and `PRISMA_CLI_QUERY_ENGINE_TYPE=library` env vars.
- `docker/docker-compose.yml`
  - Remove prebuilt image reference for `bytebot-agent` to ensure local build is used.

### Rationale
- Prisma CLI and `@prisma/client` drift and WASM engine selection caused the CLI to require a non-existent file: `@prisma/client/runtime/query_engine_bg.postgresql.wasm-base64.js`. Pinning versions and forcing the library engine removes the WASM path entirely and stabilizes builds.

### Impact
- `docker compose` builds and starts `bytebot-agent` successfully using the Node-API engine.

### Validation
- Verified with `docker compose -f docker/docker-compose.yml build --no-cache bytebot-agent` and `up -d`.
- Application now runs without the Prisma module error.

## 2025-09-10

### Initial Attempt
- Added `prisma` dependency and replaced `npx prisma` with local `prisma` binary. This reduced version drift but further changes (engine type and base image) were needed to fully resolve the issue.
