FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable

# Copy workspace manifest files first for layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

RUN pnpm install --frozen-lockfile

# Copy source files and tsconfigs
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/server/src ./packages/server/src
COPY packages/server/scripts/sprint-workflow.ts ./packages/server/scripts/
COPY packages/server/tsconfig.json packages/server/tsconfig.workflow.json ./packages/server/

# tsc --build handles project references (builds shared then server)
RUN pnpm --filter obsidiankan-mcp build && \
    cd packages/server && npx tsc -p tsconfig.workflow.json

FROM node:22-slim
WORKDIR /app

RUN corepack enable

# Copy workspace manifest files for production install
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

# Install production deps only for server (no esbuild, no obsidian, no plugin deps)
RUN pnpm install --frozen-lockfile --prod --filter obsidiankan-mcp && \
    pnpm store prune

COPY --from=builder /app/packages/server/dist ./packages/server/dist

# node:22-slim ships with a 'node' user (uid 1000).
# In Podman rootless with userns_mode: keep-id, the host UID maps to uid 1000
# inside the container, so the node user can read/write the vault volume.
USER node

EXPOSE 9375

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD node -e "\
    require('http')\
      .get('http://localhost:9375/health', r => process.exit(r.statusCode === 200 ? 0 : 1))\
      .on('error', () => process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
