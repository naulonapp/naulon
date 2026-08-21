# naulon — the gate and the console, in one image. Which one a container runs is the
# command (see docker-compose.yml); the image itself is service-agnostic.
#
# Published to ghcr.io/naulonapp/naulon by .github/workflows/image.yml. `@naulon/tollgate`
# is not on npm precisely because this is its distribution channel, so this file is what
# "install naulon" means for anyone who is not cloning the repo.
# Two stages, because "runs straight from TypeScript via tsx" is only true of the ENTRY
# module. Five workspaces (@naulon/{sdk,shared,enforce,wayfarer,wayfarer-mcp}) publish
# through `dist/`, so an import of @naulon/shared resolves to dist/index.js whatever tsx
# is doing at the top. A single `--omit=dev` stage cannot produce that: it deliberately
# has no typescript. The first image to reach a registry died on exactly this —
# ERR_MODULE_NOT_FOUND on @naulon/shared/dist/index.js, caught by the smoke test rather
# than by an operator, and invisible to a local run of the console half, which imports
# none of them.
FROM node:22-slim AS builder
WORKDIR /app

# Every workspace manifest, listed rather than globbed: `COPY packages/*/package.json`
# flattens in Docker, and a workspace npm cannot see makes `npm ci` fail. Five of the
# eight used to be here, which is why the install below carried a `|| npm install`
# fallback — a non-reproducible install dressed up as a resilient one.
COPY package.json package-lock.json ./
COPY packages/attribution/package.json   packages/attribution/
COPY packages/dashboard/package.json     packages/dashboard/
COPY packages/enforce/package.json       packages/enforce/
COPY packages/sdk/package.json           packages/sdk/
COPY packages/shared/package.json        packages/shared/
COPY packages/tollgate/package.json      packages/tollgate/
COPY packages/wayfarer/package.json      packages/wayfarer/
COPY packages/wayfarer-mcp/package.json  packages/wayfarer-mcp/

# The full install: this stage needs the typescript the runtime stage must not carry.
# No fallback. A lockfile that does not resolve is a broken build, and finding that out
# here costs a minute — finding it out from a published image costs an operator.
RUN npm ci

COPY packages/ packages/
COPY scripts/ scripts/
# Every package tsconfig extends the root one; without it tsc dies on TS5083 and then
# reports several hundred phantom "Cannot find name 'process'" errors, which read as a
# broken source tree rather than a missing file.
COPY tsconfig.base.json tsconfig.json ./

# Dependency order, not alphabetical, and the same order release.yml publishes in — each
# package typechecks against its dependencies' emitted .d.ts, so shared before enforce.
RUN npm run build -w @naulon/sdk \
 && npm run build -w @naulon/shared \
 && npm run build -w @naulon/enforce \
 && npm run build -w @naulon/wayfarer \
 && npm run build -w @naulon/wayfarer-mcp

# Drop the build-only half of node_modules in place, so the runtime stage copies a tree
# that is already production-shaped. `tsx` survives it: it is a runtime dependency of
# this repo, not a dev one, because the entry modules are never compiled.
RUN npm prune --omit=dev


FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Source, built dist and the pruned dependency tree — including the workspace symlinks
# npm puts in node_modules/@naulon/*, which resolve because the path is /app in both
# stages. .dockerignore keeps .env, .git, docs and any local ledger out of the context
# they were copied from.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./package.json

# The console writes its operator/session state (mode 0600) and both services append to
# the ledger. Owned by `node` so the container does not need root to do it — Docker
# carries this ownership onto a fresh named volume mounted here.
RUN mkdir -p /data && chown -R node:node /data
USER node
ENV EVENTS_PATH=/data/events.jsonl \
    CONSOLE_STATE_PATH=/data/console.json \
    CRAWLER_POLICY_PATH=/data/crawler-policy.json

# DASHBOARD_BIND is deliberately NOT set here. Inside a container 127.0.0.1 means
# "unreachable from the host", so widening it is what makes the console usable — and
# widening it is exactly the decision the console refuses to make on an operator's
# behalf (a reachable console with no credential closes first-run setup rather than
# offer it to a stranger). docker-compose.yml widens it and supplies the credential in
# the same breath, where both are visible together.

EXPOSE 8402 8403
# The gate is the default; compose overrides it for the console.
CMD ["npm", "run", "tollgate"]
