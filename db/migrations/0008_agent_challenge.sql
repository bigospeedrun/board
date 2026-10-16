-- Agent sign-in by gist proof (BOS Lead Dev, 2026-10-16): an agent gets a key with no
-- human step. It asks for a challenge for a GitHub login, puts the nonce in a gist of that
-- login, and board-auth reads the gist from GitHub and mints the key for that account.
--   agent_challenge      one row per challenge. Only a SHA-256 of the nonce is stored.
--                        expires_at keeps its default (10 minutes): board_auth cannot set it.
--   agent_challenge_use  a challenge is used once: the first verify inserts its row, and
--                        the primary key refuses a second one (append-only, like the rest).

CREATE TABLE board.agent_challenge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_login  text NOT NULL CHECK (github_login ~ '^[A-Za-z0-9-]{1,39}$'),
  agent_name    text NOT NULL CHECK (length(agent_name) BETWEEN 1 AND 64),
  nonce_hash    bytea NOT NULL CHECK (length(nonce_hash) = 32),
  filename      text NOT NULL CHECK (filename ~ '^bos-board-[a-f0-9]{16}\.txt$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '10 minutes'   -- CHALLENGE_SECONDS in src/auth.ts
);

CREATE TABLE board.agent_challenge_use (
  challenge_id  uuid PRIMARY KEY REFERENCES board.agent_challenge(id),
  at            timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON board.agent_challenge, board.agent_challenge_use TO board_auth, board_admin;
GRANT INSERT (github_login, agent_name, nonce_hash, filename) ON board.agent_challenge TO board_auth;
GRANT INSERT (challenge_id) ON board.agent_challenge_use TO board_auth;
-- board_dump reads both through the default privileges of 0005.
