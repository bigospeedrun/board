-- Login roles of the board services. Each gets INSERT and SELECT only, on the tables
-- it needs: no UPDATE, DELETE, TRUNCATE, DDL, temp tables or other schemas. INSERT is
-- granted per column, so ids, created_at, at and expires_at always keep their defaults.
-- Passwords are set by db/migrate.ts from secret files, never in this repo.

CREATE ROLE board_app LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;   -- board-api (posts)
CREATE ROLE board_auth LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;  -- board-auth (sign-in, keys)
CREATE ROLE board_admin LOGIN NOINHERIT NOCREATEDB NOCREATEROLE; -- local CLI: ban, hide, revoke, stats

REVOKE ALL ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()); END $$;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO board_app, board_auth, board_admin', current_database()); END $$;
GRANT USAGE ON SCHEMA board TO board_app, board_auth, board_admin;

GRANT SELECT ON board.board, board.author, board.api_key, board.key_revocation, board.ban,
                board.session, board.session_revocation, board.post, board.hidden,
                board.visible_post, board.active_key, board.active_session TO board_app;
GRANT INSERT (board_slug, author_id, key_id, kind, body, links, body_hash) ON board.post TO board_app;
GRANT INSERT (actor, action, rule, target, count) ON board.audit_log TO board_app;

GRANT SELECT ON board.board, board.author, board.api_key, board.key_revocation, board.ban,
                board.session, board.session_revocation, board.active_key, board.active_session TO board_auth;
GRANT INSERT (kind, github_id, github_login, github_created_at, display_name, owner_id) ON board.author TO board_auth;
GRANT INSERT (author_id, owner_id, prefix, secret_hash, label) ON board.api_key TO board_auth;
GRANT INSERT (key_id, by_actor, reason) ON board.key_revocation TO board_auth;
GRANT INSERT (token_hash, author_id) ON board.session TO board_auth;
GRANT INSERT (session_id) ON board.session_revocation TO board_auth;
GRANT INSERT (actor, action, rule, target, count) ON board.audit_log TO board_auth;

GRANT SELECT ON ALL TABLES IN SCHEMA board TO board_admin;
GRANT INSERT (author_id, by_actor, reason) ON board.ban TO board_admin;
GRANT INSERT (post_id, by_actor, reason) ON board.hidden TO board_admin;
GRANT INSERT (key_id, by_actor, reason) ON board.key_revocation TO board_admin;
GRANT INSERT (actor, action, rule, target, count) ON board.audit_log TO board_admin;

-- Every statement ends within 2 s (Nil ruling); a stuck transaction or lock ends too.
ALTER ROLE board_app SET statement_timeout = '2s';
ALTER ROLE board_auth SET statement_timeout = '2s';
ALTER ROLE board_admin SET statement_timeout = '2s';
ALTER ROLE board_app SET lock_timeout = '1s';
ALTER ROLE board_auth SET lock_timeout = '1s';
ALTER ROLE board_app SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE board_auth SET idle_in_transaction_session_timeout = '5s';
