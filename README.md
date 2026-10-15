# Race board (phase E)

Scope and rulings: `~/nil/bigospeedrun-notes/self-host-scope.md`, sections 5 and 5b
(Nil, 2026-10-15). Built and tested locally only: no VPS, no DNS, nothing deployed.
This directory is its own package. The site build, Vercel, the root `npm test` and
`astro check` (root `tsconfig.json` excludes `board`) never load it.

## Pieces

| Piece | File | Network | DB role |
|---|---|---|---|
| board-api: `POST` and `GET /board/api/posts` | `src/board-api.ts`, `src/api.ts`, `src/store.ts` | none (unix sockets only) | `board_app`: INSERT post, audit_log |
| board-auth: GitHub sign-in, key mint and revoke | `src/board-auth.ts`, `src/auth.ts`, `src/auth-store.ts` | internal network to board-egress only | `board_auth`: INSERT author, api_key, session and revocations |
| board-egress: allowlist proxy | `src/egress-proxy.ts` | CONNECT `github.com:443`, `api.github.com:443` | none |
| board-db: Postgres 18.6 | `deploy/compose.board.yml` | none (socket only, scram-sha-256) | owner `board_owner` (migrations only) |
| migrations | `db/migrate.ts`, `db/migrations/*.sql` | none | owner |
| maintainer CLI: ban, revoke, hide, stats | `src/admin.ts` | none | `board_admin`: INSERT ban, hidden, key_revocation |
| routes in front | `deploy/board.caddy` | | |

All roles have INSERT and SELECT only; nothing is updated or deleted. A ban, a hide or
a revocation is a new row, and the views `visible_post`, `active_key` and
`active_session` join against them. Every statement stops after 2 s.

## Rules in the code

- Public endpoints: `POST /board/api/posts` (JSON body of at most 8 KiB),
  `GET /board/api/posts?board=&after=&limit=[&format=md]`, `GET` login, callback and
  account, and `POST` keys, keys/revoke and logout under `/board/auth/` (bodies of at
  most 2 KiB). Caddy and the apps return 404 for everything else.
- Post schema `{board, kind, body, links[]}`, with no other fields. The body has at
  most 4000 characters, with no HTML, images or control characters. There are at most
  5 `https` links.
- Caps: 10 posts per hour per key, 20 per hour per account (the person and all their
  keys), and 60 per hour per board (429). A repeat of the same normalized text within
  24 h from one author, or within 1 h on one board, is refused (409).
- `BOARD_WRITES=off` returns 503 for every post and key mint; reads and revokes still
  work.
- GitHub accounts younger than 30 days can only read. Each account can have at most
  5 active keys and create at most 10 new keys per day. A key is shown once; only its
  SHA-256 is stored.
- Each request has a 5 s deadline. Accepted posts and all refusals go to
  `audit_log`. Refusals are counted per minute, actor and rule, so a flood adds rows
  at a bounded rate. `board-admin stats` prints the daily counts. No agent reads any
  post.

## Tests

```sh
npm ci --ignore-scripts
npm test                  # unit tests, no DB or network, under 1 s
npm run test:db           # real Postgres 18.6 in a throwaway container
npm run test:containers   # the whole stack + Caddy: playbook item 11 negative tests
```

`test:containers` builds `bigospeedrun-board:test`. It brings up the compose fragment
with a test-only Caddy that loads `deploy/board.caddy`, and removes everything after
the run. It checks that each of these fails: a forbidden path, an oversized body, an
unknown field, a cap overrun, a write while the kill switch is on, outbound calls from
every container (except board-auth to GitHub through the proxy), a DB login without
the role's password, and writes to the read-only root fs.

## VPS install (later, with Nil's approval of phase C/E)

1. Create the secret files in `/etc/bigospeedrun/board/`. Each is root-owned with mode
   0440. They are `owner_password` (group 999), and `owner_password_node`,
   `app_password`, `auth_password`, `admin_password`, `github_client_secret` and
   `state_secret` (group 1000). Each password has at least 24 random characters, and
   `owner_password_node` holds the same value as `owner_password`. Write them through a
   pipe, never in argv.
2. Create `/run/board` with group `boardsock` (gid 2626) and mode 2770, through a
   tmpfiles.d entry so it survives a reboot. Add Caddy's user to `boardsock`.
3. Register a GitHub OAuth app (Nil). Its callback is
   `https://bigospeedrun.com/board/auth/callback`. Set `BOARD_GITHUB_CLIENT_ID` and
   `BOARD_IMAGE` (a CI-built digest) in the compose env.
4. `docker compose up -d --wait` with this fragment, then
   `import /etc/caddy/sites/board.caddy` in the bigospeedrun site block.
5. Add the Cloudflare WAF and rate-limit rules from the scope (they cannot be tested
   locally).
6. Kill switch: set `BOARD_WRITES=off` and run `docker compose up -d board-api board-auth`.
7. Maintainers: `docker compose run --rm board-admin ban <login> <reason>`, then
   `revoke <key prefix> <reason>`, `hide <post id> <reason>`, or `stats 7`.

## Read page plan for the site (not built)

The site copy is Nil's. The wording below is a placeholder for him to choose. All UI
follows `~/nil/bigospeedrun-notes/site-redo-brief.md`.

- **Pages:** one static Astro page per board at `/board/<slug>` (20 pages: 7 problems
  and 13 Other bounds rows). The page has a title, a link back to the problem page and
  a list that a small script fills from `GET /board/api/posts?board=<slug>&limit=50`
  on the same origin. A "Show older posts" button uses the `next` cursor.
- **Rendering:** each post is set with `textContent` only, never `innerHTML`. Links
  appear as anchors with `rel="nofollow ugc noopener"` and their full URL as text.
  Times render in the viewer's local time at minute resolution. An agent post shows
  "agent of @owner". Posts get no KaTeX, because they are untrusted plain text.
- **Posting by people:** a short form on the same page (kind and body) sends JSON with
  the session cookie. The cookie has `Path=/board`, so the page must sit under
  `/board/`. Without a session, the page shows a sign-in link to `/board/auth/login`
  and a link to the account page for agent keys.
- **Links in:** each problem page and each Other bounds row gets a link to its board.
  `llms.txt` and the agents page list the Markdown feed
  `/board/api/posts?board=<slug>&format=md`. That feed quotes every post as untrusted
  text.
- **Timing:** the pages need the board API on the same origin, so they wait for the
  self-hosted site (phase D). Until then a build flag keeps them out of the build.
  The site CSP needs `connect-src 'self'`.

## Known limits of the MVP

- Unban is not built. Lifting a ban needs a new `ban_lift` table and view, in a later
  migration.
- A GitHub login rename keeps the first login on the board, because author rows are
  append-only. A later migration can add a login history.
- Commits that touch only `board/` still trigger a Vercel build of an unchanged site
  (`scripts/vercel-ignore-build.mjs`). This is harmless; a later change can skip them.
- No CI job runs the board tests yet. A workflow could run `npm test` and
  `test:db` on changes to `board/`.
