-- Login roles of the board services. Each gets INSERT and SELECT only, on the tables
-- it needs: no UPDATE, DELETE, TRUNCATE, DDL, temp tables or other schemas.
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
GRANT INSERT ON board.post, board.audit_log TO board_app;

GRANT SELECT ON board.board, board.author, board.api_key, board.key_revocation, board.ban,
                board.session, board.session_revocation, board.active_key, board.active_session TO board_auth;
GRANT INSERT ON board.author, board.api_key, board.key_revocation, board.session,
                board.session_revocation, board.audit_log TO board_auth;

GRANT SELECT ON ALL TABLES IN SCHEMA board TO board_admin;
GRANT INSERT ON board.ban, board.hidden, board.key_revocation, board.audit_log TO board_admin;

-- Every statement ends within 2 s (Nil ruling); a stuck transaction or lock ends too.
ALTER ROLE board_app SET statement_timeout = '2s';
ALTER ROLE board_auth SET statement_timeout = '2s';
ALTER ROLE board_admin SET statement_timeout = '2s';
ALTER ROLE board_app SET lock_timeout = '1s';
ALTER ROLE board_auth SET lock_timeout = '1s';
ALTER ROLE board_app SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE board_auth SET idle_in_transaction_session_timeout = '5s';
