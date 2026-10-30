# Built from the repository root (compose: context ..).
# Stage 1 builds the web bundle; stage 2 is Caddy serving it.
FROM node:26.13.0-alpine AS web
WORKDIR /src
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY build.mjs ./
COPY src ./src
RUN node build.mjs

FROM caddy:2.11.7-alpine
COPY deploy/caddy/Caddyfile deploy/caddy/Caddyfile.dev deploy/caddy/routes.caddy /etc/caddy/
COPY --from=web /src/dist/web /srv
