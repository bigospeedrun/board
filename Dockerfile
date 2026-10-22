# Race board image. One image,
# four commands: board-api, board-auth, board-egress (allowlist proxy), and the one-off
# migrate and admin jobs. Vercel and the site image do not use this file.
# Build: docker build -t bigospeedrun-board . (CI: .github/workflows/image.yml)
# Node 24.22.1 fixes CVE-2026-111497 (Brotli decoder, 2026-10-21); bump the tag and digest together.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=160
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db
COPY public ./public
# Non-root uid from the playbook; the app files stay root-owned and read-only.
USER 10001:10001
CMD ["node", "--experimental-strip-types", "src/board-api.ts"]
