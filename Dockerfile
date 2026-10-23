# syntax=docker/dockerfile:1
# Multi-stage build: deps -> build -> minimal non-root runtime with Next's standalone output.
# Base image pinned by exact version and multi-arch index digest. To update: pick the newest
# node:24.x.y-bookworm-slim tag, then `docker buildx imagetools inspect node:<tag>` and copy its Digest.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# The server needs only `node`: drop npm, npx, corepack and yarn so they cannot run (attack surface).
# shortcut: their files stay in the base layer (image size unchanged, scanners still list npm's deps);
# a node-only base (distroless or COPY of the node binary) would remove them for real.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
# The official image ships an unprivileged `node` user (uid 1000). Files stay root-owned (read-only for node).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# Standalone output leaves out public/ (logo etc.); it must be copied next to server.js.
COPY --from=build /app/public ./public
COPY --from=build /app/migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Node is PID 1: Next's server handles SIGTERM itself (stops accepting, drains requests, exits 0).
CMD ["node", "server.js"]
