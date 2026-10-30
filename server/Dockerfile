# The api. Built from the repository root (compose: context ..), because it
# imports src/domain directly — Node 26 runs the TypeScript as it is.
FROM node:26.13.0-alpine
WORKDIR /app
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY server ./server
COPY src/domain ./src/domain
COPY src/wire.ts ./src/wire.ts
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["node", "server/main.ts"]
