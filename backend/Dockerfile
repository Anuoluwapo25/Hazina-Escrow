FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS dev
WORKDIR /app
COPY . .
RUN mkdir -p /app/data
EXPOSE 3001
CMD ["npm", "run", "start:dev"]

# Sentinel dev target: same image, its own entrypoint. Runs as an
# independent container so a compromised/crashed API host doesn't silently
# take the watcher down with it — see docs/MONITORING.md.
FROM deps AS sentinel-dev
WORKDIR /app
COPY . .
RUN mkdir -p /app/data
EXPOSE 3002
CMD ["npx", "ts-node-dev", "--respawn", "--transpile-only", "src/sentinel/standalone.ts"]

FROM deps AS builder
WORKDIR /app
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
# Pick up patched OS packages (e.g. openssl) and a current npm — the bundled
# npm CLI's own vendored deps (cross-spawn, glob, tar, etc.) are scanned even
# though npm itself isn't invoked at runtime.
RUN apk update && apk upgrade --no-cache && npm install -g npm@latest
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data
EXPOSE 3001
CMD ["node", "dist/main.js"]

# Sentinel production target: identical build artifact as the API image,
# different CMD. Deploy this as its own service/container, not a replica of
# the API — see docs/MONITORING.md.
FROM production AS sentinel
EXPOSE 3002
CMD ["node", "dist/sentinel/standalone.js"]
