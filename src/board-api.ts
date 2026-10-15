// board-api server. In the container it has no network (network_mode: none): it
// listens on a unix socket that Caddy reaches, and talks to Postgres over a unix
// socket. Env: BOARD_SOCKET (or BOARD_PORT for local tests), PGHOST (socket dir),
// PGDATABASE, PGUSER=board_app, PGPASSWORD_FILE, BOARD_WRITES, BOARD_ORIGIN.
import {createServer} from 'node:http';
import {chmodSync, readFileSync, rmSync} from 'node:fs';
import pg from 'pg';
import {configFrom, LIMITS} from './rules.ts';
import {createApi, RefusalLog} from './api.ts';
import {pgStore} from './store.ts';

export function start(env: NodeJS.ProcessEnv = process.env) {
  const config = configFrom(env);
  const password = env.PGPASSWORD_FILE ? readFileSync(env.PGPASSWORD_FILE, 'utf8').trim() : env.PGPASSWORD;
  const pool = new pg.Pool({password, max: 5, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30000});
  pool.on('error', () => {}); // A dropped idle connection must not end the process.
  const store = pgStore(pool);
  const refusals = new RefusalLog(store);
  const server = createServer({requestTimeout: LIMITS.requestMs, headersTimeout: LIMITS.requestMs, maxHeaderSize: 8192},
    createApi(store, config, refusals));
  server.keepAliveTimeout = 5000;
  const flush = setInterval(() => refusals.flush().catch(() => {}), 10000);
  if (env.BOARD_SOCKET) {
    rmSync(env.BOARD_SOCKET, {force: true});
    server.listen(env.BOARD_SOCKET, () => chmodSync(env.BOARD_SOCKET!, 0o660));
  } else server.listen(Number(env.BOARD_PORT ?? 0), '127.0.0.1');
  const stop = async () => {
    clearInterval(flush);
    await new Promise(r => server.close(r));
    await refusals.flush().catch(() => {});
    await pool.end();
  };
  return {server, pool, refusals, stop};
}

if (import.meta.main) {
  const {stop} = start();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stop().finally(() => process.exit(0)); });
  console.log(JSON.stringify({service: 'board-api', writes: process.env.BOARD_WRITES ?? 'on'}));
}
