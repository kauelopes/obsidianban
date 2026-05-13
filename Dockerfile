FROM node:22-slim

WORKDIR /app

# Install dependencies first — better-sqlite3 ships pre-compiled glibc
# binaries, so no build tools (python3/make/g++) are needed.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# node:22-slim ships with a 'node' user (uid 1000).
# In Podman rootless with userns_mode: keep-id, the host UID maps to uid 1000
# inside the container, so the node user can read/write the vault volume.
USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD node -e "\
    require('http')\
      .get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1))\
      .on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
