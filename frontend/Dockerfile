FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS dev
WORKDIR /app
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

FROM deps AS builder
WORKDIR /app
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS production
# Pick up patched OS packages (openssl, libxml2, libpng, etc.) beyond what's
# baked into this image tag's layer.
RUN apk update && apk upgrade --no-cache
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
