# One image, two entrypoints: the server (default) and the per-task worker.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# The admin page (web/, React + Astryx) is built into public/; it imports the server's types.
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# Tools the agents need to work on arbitrary projects. Extend this image
# (FROM agent-army) to add the toolchains your repos use: Go, Java, pnpm, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq ripgrep python3 python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && mkdir -p /data && chown node:node /data
# Coding agent CLIs the team can hand repo work to (src/engines.ts), pinned.
# ENGINES says which: "codex gemini" (the default), one of them, or "" for
# neither (an engine whose CLI is missing is left out of tasks, with a note).
# Codex adds about 420 MB (a native binary), Gemini CLI about 100 MB.
ARG ENGINES="codex gemini"
ARG CODEX_VERSION=0.171.0
ARG GEMINI_CLI_VERSION=0.70.0
RUN set -e; pkgs=""; \
    for engine in $ENGINES; do \
      case "$engine" in \
        codex) pkgs="$pkgs @openai/codex@${CODEX_VERSION}" ;; \
        gemini) pkgs="$pkgs @google/gemini-cli@${GEMINI_CLI_VERSION}" ;; \
        *) echo "Unknown engine in ENGINES: $engine" >&2; exit 1 ;; \
      esac; \
    done; \
    if [ -n "$pkgs" ]; then npm install -g --ignore-scripts --no-audit --no-fund $pkgs && npm cache clean --force; fi
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
COPY --from=build /app/public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data HOME=/home/node
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/server.js"]
