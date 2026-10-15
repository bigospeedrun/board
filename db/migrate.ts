// Apply board/db/migrations/*.sql in name order, once each, as the owner role.
// Then set the service role passwords from secret files (never printed or logged).
//
// Env: PGHOST (socket dir or host), PGPORT, PGDATABASE, PGUSER (owner),
// PGPASSWORD_FILE, and optionally BOARD_APP_PASSWORD_FILE, BOARD_AUTH_PASSWORD_FILE,
// BOARD_ADMIN_PASSWORD_FILE.
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const ROLES = {board_app: 'BOARD_APP_PASSWORD_FILE', board_auth: 'BOARD_AUTH_PASSWORD_FILE', board_admin: 'BOARD_ADMIN_PASSWORD_FILE'};

export function migrationFiles(dir = DIR): string[] {
  return readdirSync(dir).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
}

export async function migrate(client: pg.Client, env: NodeJS.ProcessEnv = process.env, dir = DIR): Promise<string[]> {
  await client.query('CREATE SCHEMA IF NOT EXISTS board_meta');
  await client.query('CREATE TABLE IF NOT EXISTS board_meta.migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await client.query('SELECT name FROM board_meta.migration')).rows.map(r => r.name));
  const applied: string[] = [];
  for (const name of migrationFiles(dir)) {
    if (done.has(name)) continue;
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(dir + name, 'utf8'));
      await client.query('INSERT INTO board_meta.migration (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      applied.push(name);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`);
    }
  }
  for (const [role, variable] of Object.entries(ROLES)) {
    const file = env[variable];
    if (!file) continue;
    const password = readFileSync(file, 'utf8').trim();
    if (password.length < 24) throw new Error(`${variable}: password shorter than 24 characters`);
    // ALTER ROLE takes no bind parameters; escapeLiteral quotes the value safely.
    await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(password)}`);
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const password = process.env.PGPASSWORD_FILE ? readFileSync(process.env.PGPASSWORD_FILE, 'utf8').trim() : undefined;
  const client = new pg.Client({password});
  await client.connect();
  try { console.log(JSON.stringify({applied: await migrate(client)})); }
  finally { await client.end(); }
}
