# naulon — the gate and the console, in one image. Which one a container runs is the
# command (see docker-compose.yml); the image itself is service-agnostic.
#
# Published to ghcr.io/naulonapp/naulon by .github/workflows/image.yml. `@naulon/tollgate`
# is not on npm precisely because this is its distribution channel, so this file is what
# "install naulon" means for anyone who is not cloning the repo.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

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

# No fallback. A lockfile that does not resolve is a broken build, and finding that out
# here costs a minute — finding it out from a published image costs an operator.
# `--omit=dev` keeps typescript and the type packages out; `tsx` is a runtime dependency
# of this repo, not a dev one, because nothing here is compiled before it runs.
RUN npm ci --omit=dev

# Source only — .dockerignore keeps .env, node_modules, .git, docs, tests and any local
# ledger out. Everything runs straight from TypeScript via tsx, same as in development.
COPY packages/ packages/
COPY scripts/ scripts/
COPY package.json ./

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
