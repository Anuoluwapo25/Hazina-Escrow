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
