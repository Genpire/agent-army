# One image, two entrypoints: the server (default) and the per-task worker.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# Tools the agents need to work on arbitrary projects. Extend this image
# (FROM agent-army) to add the toolchains your repos use: Go, Java, pnpm, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq ripgrep python3 python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
# Headless Chromium for browser checks in repo tasks (the Playwright MCP server).
# Installed with the Playwright CLI that @playwright/mcp uses, so the browser
# build matches it; system libraries come with --with-deps. Set BROWSER=off at
# runtime to give agents no browser.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node node_modules/playwright/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data HOME=/home/node
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/server.js"]
