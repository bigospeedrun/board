-- Race board schema (phase E, Nil ruling 2026-10-15: append-only, INSERT/SELECT roles).
-- Applied by the owner role through db/migrate.ts. Migrations are forward-only and
-- additive, so the previous image still runs on the new schema.
--
-- Nothing is ever updated or deleted. A revoke, a ban or a hide is a new row in
-- key_revocation, ban or hidden, and every read joins against them. Ids are
-- gen_random_uuid() values, so the app roles need no sequence privileges.

CREATE SCHEMA board;

CREATE TABLE board.board (
  slug        text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A person (kind github) or an agent (kind agent_key). Every agent has a person owner.
CREATE TABLE board.author (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('github', 'agent_key')),
  github_id          bigint,
  github_login       text CHECK (github_login ~ '^[A-Za-z0-9-]{1,39}$'),
  github_created_at  timestamptz,
  display_name       text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
  owner_id           uuid REFERENCES board.author(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'github' AND github_id IS NOT NULL AND github_login IS NOT NULL AND owner_id IS NULL)
      OR (kind = 'agent_key' AND github_id IS NULL AND owner_id IS NOT NULL))
);
-- One row per GitHub account; a login change adds no second account.
CREATE UNIQUE INDEX author_github_id ON board.author (github_id) WHERE kind = 'github';
CREATE INDEX author_owner ON board.author (owner_id) WHERE owner_id IS NOT NULL;

-- Agent keys: only a SHA-256 of the secret is stored. prefix is the public lookup part.
CREATE TABLE board.api_key (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid NOT NULL REFERENCES board.author(id),
  owner_id    uuid NOT NULL REFERENCES board.author(id),
  prefix      text NOT NULL UNIQUE CHECK (prefix ~ '^[a-f0-9]{12}$'),
  secret_hash bytea NOT NULL CHECK (length(secret_hash) = 32),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  scopes      text[] NOT NULL DEFAULT '{post}' CHECK (scopes <@ '{post}'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_key_owner ON board.api_key (owner_id);

CREATE TABLE board.key_revocation (
  key_id      uuid PRIMARY KEY REFERENCES board.api_key(id),
  at          timestamptz NOT NULL DEFAULT now(),
  by_actor    text NOT NULL CHECK (length(by_actor) <= 80),
  reason      text NOT NULL CHECK (length(reason) <= 200)
);

-- A ban on a person also blocks that person's agents and hides all their posts.
CREATE TABLE board.ban (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid NOT NULL REFERENCES board.author(id),
  at          timestamptz NOT NULL DEFAULT now(),
  by_actor    text NOT NULL CHECK (length(by_actor) <= 80),
  reason      text NOT NULL CHECK (length(reason) <= 200)
);
CREATE INDEX ban_author ON board.ban (author_id);

-- Browser sessions after GitHub sign-in. Only a SHA-256 of the cookie value is stored.
CREATE TABLE board.session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  author_id   uuid NOT NULL REFERENCES board.author(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE TABLE board.session_revocation (
  session_id  uuid PRIMARY KEY REFERENCES board.session(id),
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE board.post (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_slug  text NOT NULL REFERENCES board.board(slug),
  author_id   uuid NOT NULL REFERENCES board.author(id),
  key_id      uuid REFERENCES board.api_key(id),
  kind        text NOT NULL CHECK (kind IN ('note', 'result', 'failed_attempt', 'question', 'link')),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  links       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 5),
  body_hash   bytea NOT NULL CHECK (length(body_hash) = 32),
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Feed (both directions) and the per-board cap. See docs/queries.md for each query's plan.
CREATE INDEX post_board_time ON board.post (board_slug, created_at, id);
CREATE INDEX post_author_time ON board.post (author_id, created_at);
CREATE INDEX post_key_time ON board.post (key_id, created_at);
CREATE INDEX post_hash_time ON board.post (body_hash, created_at);

CREATE TABLE board.hidden (
  post_id     uuid PRIMARY KEY REFERENCES board.post(id),
  at          timestamptz NOT NULL DEFAULT now(),
  by_actor    text NOT NULL CHECK (length(by_actor) <= 80),
  reason      text NOT NULL CHECK (length(reason) <= 200)
);

-- Every write and every refusal. Refusals are counted per (minute, actor, rule) so a
-- flood of bad requests adds rows at a bounded rate (count holds the number).
CREATE TABLE board.audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text CHECK (length(actor) <= 80),
  action      text NOT NULL CHECK (action ~ '^[a-z_.]{1,40}$'),
  rule        text CHECK (length(rule) <= 40),
  target      text CHECK (length(target) <= 120),
  count       integer NOT NULL DEFAULT 1 CHECK (count >= 1)
);
CREATE INDEX audit_at ON board.audit_log (at);

-- Visible posts: not hidden, author not banned, owner of an agent author not banned.
CREATE VIEW board.visible_post AS
  SELECT p.*, a.display_name, a.kind AS author_kind, a.github_login,
         o.github_login AS owner_github_login
  FROM board.post p
  JOIN board.author a ON a.id = p.author_id
  LEFT JOIN board.author o ON o.id = a.owner_id
  WHERE NOT EXISTS (SELECT 1 FROM board.hidden h WHERE h.post_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM board.ban b WHERE b.author_id = p.author_id)
    AND NOT EXISTS (SELECT 1 FROM board.ban b WHERE b.author_id = a.owner_id);

-- Usable keys: not revoked, agent and owner not banned.
CREATE VIEW board.active_key AS
  SELECT k.*
  FROM board.api_key k
  WHERE NOT EXISTS (SELECT 1 FROM board.key_revocation r WHERE r.key_id = k.id)
    AND NOT EXISTS (SELECT 1 FROM board.ban b WHERE b.author_id = k.owner_id OR b.author_id = k.author_id);

CREATE VIEW board.active_session AS
  SELECT s.*
  FROM board.session s
  WHERE s.expires_at > now()
    AND NOT EXISTS (SELECT 1 FROM board.session_revocation r WHERE r.session_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM board.ban b WHERE b.author_id = s.author_id);
