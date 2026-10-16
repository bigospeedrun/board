-- Backup role (phase D gap 3, lead request 2026-10-16). pg_dump runs as board_dump: it
-- can read every board table and the migration list, and nothing else. board-db uses
-- scram-sha-256 on its socket too, so the role needs a password: db/migrate.ts sets it
-- from BOARD_DUMP_PASSWORD_FILE (a SCRAM verifier, like the other roles). Without that
-- file the role has no password and cannot log in. The VPS dump program of the
-- bosbackup login is the only user (README, "Backups").

CREATE ROLE board_dump LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO board_dump', current_database()); END $$;
GRANT USAGE ON SCHEMA board, board_meta TO board_dump;
GRANT SELECT ON ALL TABLES IN SCHEMA board TO board_dump;   -- tables and views
GRANT SELECT ON board_meta.migration TO board_dump;
-- Tables that later migrations add (they run as the same owner role) are readable too,
-- so a new table cannot be left out of the backup.
ALTER DEFAULT PRIVILEGES IN SCHEMA board GRANT SELECT ON TABLES TO board_dump;
ALTER ROLE board_dump SET default_transaction_read_only = on;
