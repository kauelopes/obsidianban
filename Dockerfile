FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-slim
WORKDIR /app
# better-sqlite3 ships pre-compiled glibc binaries — no build tools needed.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder /app/dist ./dist

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

CMD ["node", "dist/index.js"]
