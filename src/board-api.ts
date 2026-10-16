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
  // Separate read and write pools: posts waiting on advisory locks cannot take the
  // clients that feeds and key lookups need.
  const options = {password, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30000};
  const write = new pg.Pool({...options, max: 3}), read = new pg.Pool({...options, max: 4});
  for (const p of [write, read]) p.on('error', () => {}); // A dropped idle connection must not end the process.
  const store = pgStore(write, read);
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
    await Promise.all([write.end(), read.end()]);
  };
  return {server, pools: [write, read], refusals, stop};
}

if (import.meta.main) {
  const {stop} = start();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stop().finally(() => process.exit(0)); });
  console.log(JSON.stringify({service: 'board-api', writes: process.env.BOARD_WRITES ?? 'on'}));
}
