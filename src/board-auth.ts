// board-auth server. Listens on a unix socket that Caddy reaches. Its only network is
// the internal one to the egress proxy, which allows github.com:443 and
// api.github.com:443 and nothing else. Env: BOARD_SOCKET (or BOARD_PORT for tests),
// PGHOST (socket dir), PGDATABASE, PGUSER=board_auth, PGPASSWORD_FILE, BOARD_ORIGIN,
// BOARD_WRITES, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET_FILE, BOARD_STATE_SECRET_FILE,
// NODE_USE_ENV_PROXY=1 and HTTPS_PROXY (set by compose).
import {createServer} from 'node:http';
import {chmodSync, readFileSync, rmSync} from 'node:fs';
import pg from 'pg';
import {configFrom, LIMITS} from './rules.ts';
import {createAuth, githubClient} from './auth.ts';
import {RefusalLog} from './api.ts';
import {pgAuthStore} from './auth-store.ts';

const secretFile = (env: NodeJS.ProcessEnv, name: string) => {
  const file = env[name];
  if (!file) throw new Error(name + ' is required');
  const value = readFileSync(file, 'utf8').trim();
  if (value.length < 20) throw new Error(name + ' looks too short');
  return value;
};

export function start(env: NodeJS.ProcessEnv = process.env) {
  const config = configFrom(env);
  if (!/^[A-Za-z0-9.]{10,40}$/.test(env.GITHUB_CLIENT_ID ?? '')) throw new Error('GITHUB_CLIENT_ID is required');
  const pool = new pg.Pool({password: env.PGPASSWORD_FILE ? readFileSync(env.PGPASSWORD_FILE, 'utf8').trim() : env.PGPASSWORD,
    max: 3, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30000});
  pool.on('error', () => {});
  const store = pgAuthStore(pool);
  const refusals = new RefusalLog({audit: rows => store.auditBatch(rows)});
  const handler = createAuth(store, githubClient(env.GITHUB_CLIENT_ID!, secretFile(env, 'GITHUB_CLIENT_SECRET_FILE')), config,
    {clientId: env.GITHUB_CLIENT_ID!, stateSecret: Buffer.from(secretFile(env, 'BOARD_STATE_SECRET_FILE'))}, LIMITS.requestMs, refusals);
  const flush = setInterval(() => refusals.flush().catch(() => {}), 10000);
  const server = createServer({requestTimeout: LIMITS.requestMs, headersTimeout: LIMITS.requestMs, maxHeaderSize: 8192}, handler);
  if (env.BOARD_SOCKET) {
    rmSync(env.BOARD_SOCKET, {force: true});
    server.listen(env.BOARD_SOCKET, () => chmodSync(env.BOARD_SOCKET!, 0o660));
  } else server.listen(Number(env.BOARD_PORT ?? 0), '127.0.0.1');
  return {server, pool, stop: async () => {
    clearInterval(flush);
    await new Promise(r => server.close(r));
    await refusals.flush().catch(() => {});
    await pool.end();
  }};
}

if (import.meta.main) {
  const {stop} = start();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stop().finally(() => process.exit(0)); });
  console.log(JSON.stringify({service: 'board-auth'}));
}
