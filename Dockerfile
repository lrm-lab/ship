FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# The Prisma client is generated into src/generated (git-ignored), so it is generated here, then
# bundled into dist/server.js with everything else the server imports.
FROM deps AS build
COPY tsconfig.json prisma.config.ts ./
COPY prisma prisma
COPY src src
RUN bun run build

# Target `migrate`: the one-shot job that applies the migrations (`docker build --target migrate`).
# It needs the Prisma CLI and its schema engine, which needs OpenSSL on Alpine.
FROM base AS migrate
RUN apk add --no-cache openssl
COPY --from=deps --chown=bun:bun /app/node_modules node_modules
COPY --chown=bun:bun package.json prisma.config.ts ./
COPY --chown=bun:bun prisma prisma
USER bun
CMD ["bunx", "--bun", "prisma", "migrate", "deploy"]

# The default target: the server alone. dist/server.js bundles everything it imports.
FROM base
ENV HOST=0.0.0.0 \
    NODE_ENV=production
COPY --from=build --chown=bun:bun /app/dist dist
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/healthz"
CMD ["bun", "dist/server.js"]
