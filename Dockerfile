# naulon — runs the tollgate or dashboard (set the command in compose).
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Install workspace deps with the lockfile for reproducibility.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/tollgate/package.json packages/tollgate/
COPY packages/wayfarer/package.json packages/wayfarer/
COPY packages/attribution/package.json packages/attribution/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm ci --omit=dev || npm install --omit=dev

# Source (runs straight from TS via tsx — no build step).
COPY . .

EXPOSE 8402 8403
# Default to the tollgate; docker-compose overrides per service.
CMD ["npm", "run", "tollgate"]
