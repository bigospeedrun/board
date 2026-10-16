// Throwaway Postgres for DB tests: the same image as the compose fragment, data on
// tmpfs, published on a random 127.0.0.1 port, removed after the tests.
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {migrate} from '../../db/migrate.ts';

export const PG_IMAGE = 'postgres:18.6-bookworm@sha256:7d3852670a11f0cb9cb1cd50916dc02a0021143fb22d96b78eeef26348abe55c'; // same as compose
export type Role = 'board_owner' | 'board_app' | 'board_auth' | 'board_admin';
export interface TestDb {port: number; passwords: Record<Role, string>; client(role: Role): Promise<pg.Client>; stop(): void}

const docker = (...args: string[]) => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();

export async function startDb(): Promise<TestDb> {
  const name = 'bos-board-test-' + randomBytes(4).toString('hex');
  const passwords = Object.fromEntries((['board_owner', 'board_app', 'board_auth', 'board_admin'] as Role[])
    .map(r => [r, randomBytes(18).toString('base64url')])) as Record<Role, string>;
  docker('run', '-d', '--rm', '--name', name, '--tmpfs', '/var/lib/postgresql:rw',
    '-e', 'POSTGRES_USER=board_owner', '-e', 'POSTGRES_DB=board', '-e', `POSTGRES_PASSWORD=${passwords.board_owner}`,
    '-e', 'POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256',
    '-p', '127.0.0.1::5432', PG_IMAGE);
  const stop = () => { try { docker('rm', '-f', name); } catch {} };
  try {
    const port = Number(docker('port', name, '5432/tcp').split('\n')[0].split(':').pop());
    const connect = async (role: Role) => {
      const client = new pg.Client({host: '127.0.0.1', port, database: 'board', user: role, password: passwords[role]});
      await client.connect();
      return client;
    };
    let owner: pg.Client | undefined;
    for (let i = 0; i < 120 && !owner; i++) {
      try {
        owner = await connect('board_owner');
        await owner.query('SELECT 1');
      } catch { owner = undefined; await new Promise(r => setTimeout(r, 250)); }
    }
    if (!owner) throw new Error('test Postgres did not start');
    const dir = mkdtempSync(join(tmpdir(), 'bos-board-pw-'));
    const env: Record<string, string> = {};
    for (const [role, variable] of [['board_app', 'BOARD_APP_PASSWORD_FILE'], ['board_auth', 'BOARD_AUTH_PASSWORD_FILE'], ['board_admin', 'BOARD_ADMIN_PASSWORD_FILE']] as const) {
      const file = join(dir, role);
      writeFileSync(file, passwords[role] + '\n', {mode: 0o600});
      env[variable] = file;
    }
    await migrate(owner, env);
    await owner.end();
    return {port, passwords, client: connect, stop};
  } catch (error) { stop(); throw error; }
}
