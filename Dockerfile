FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# The Prisma client is generated into src/generated (git-ignored), so it is generated here, then
# bundled into dist/server.js with everything else the server imports.
COPY tsconfig.json prisma.config.ts ./
COPY prisma prisma
COPY src src
RUN bun run build

# Production dependencies only: the Prisma CLI that `migrate deploy` runs, and what it loads.
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS migrate

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a

WORKDIR /app
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

# Least often changed first: the migration toolchain, then the schema and migrations, then the
# bundle. dist/server.js needs nothing from node_modules; the toolchain is for the one-shot
#   bunx --bun prisma migrate deploy
# which runs in this same image against the same DATABASE_URL, before the server starts.
COPY --from=migrate --chown=bun:bun /app/node_modules node_modules
COPY --chown=bun:bun package.json prisma.config.ts ./
COPY --chown=bun:bun prisma prisma
COPY --from=build --chown=bun:bun /app/dist dist

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz
CMD ["bun", "dist/server.js"]
