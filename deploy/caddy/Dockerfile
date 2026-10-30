# Built from the repository root (compose: context ..).
# Stage 1 builds the web bundle; stage 2 builds Caddy with the rate-limit
# plugin (stock Caddy has none); stage 3 is that Caddy serving the bundle.
FROM node:26.13.0-alpine AS web
WORKDIR /src
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY build.mjs ./
COPY src ./src
RUN node build.mjs

FROM caddy:2.11.7-builder-alpine AS caddy
RUN xcaddy build --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2.11.7-alpine
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY deploy/caddy/Caddyfile deploy/caddy/Caddyfile.dev deploy/caddy/routes.caddy /etc/caddy/
COPY --from=web /src/dist/web /srv
