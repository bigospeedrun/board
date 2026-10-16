# Race board image. One image,
# four commands: board-api, board-auth, board-egress (allowlist proxy), and the one-off
# migrate and admin jobs. Vercel and the site image do not use this file.
# Build from the repository root: docker build -f board/Dockerfile -t bigospeedrun-board board
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=160
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db
# Non-root uid from the playbook; the app files stay root-owned and read-only.
USER 10001:10001
CMD ["node", "--experimental-strip-types", "src/board-api.ts"]
