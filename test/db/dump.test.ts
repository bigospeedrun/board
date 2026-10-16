// Backup role board_dump on a real Postgres: it reads everything pg_dump needs and
// writes nothing. The dump runs the way the VPS dump program runs it: pg_dump inside the
// db container, over the local socket, with the password in PGPASSWORD (never in argv).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {startDb, type TestDb} from './pg.ts';

let db: TestDb;
before(async () => { db = await startDb(); });
after(() => db?.stop());

const dockerExec = (password: string | null, ...cmd: string[]) => spawnSync('docker',
  ['exec', ...(password === null ? [] : ['-e', 'PGPASSWORD']), '-u', 'postgres', db.container, ...cmd],
  {env: {...process.env, ...(password === null ? {} : {PGPASSWORD: password})}, maxBuffer: 64 << 20});

test('board_dump reads every board table and the migration list, and writes nothing', async () => {
  const owner = await db.client('board_owner');
  // A table from a later migration (same owner) is readable without a new grant.
  await owner.query('CREATE TABLE board.later_table (x int)');
  const tables = (await owner.query(`SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
      WHERE table_schema IN ('board', 'board_meta') ORDER BY 1`)).rows.map(r => r.t);
  await owner.end();
  const dump = await db.client('board_dump');
  for (const t of tables) await dump.query(`SELECT 1 FROM ${t} LIMIT 1`);
  assert.ok(tables.includes('board.post') && tables.includes('board_meta.migration') && tables.includes('board.visible_post'));
  assert.equal((await dump.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');
  await assert.rejects(dump.query(`INSERT INTO board.audit_log (action) VALUES ('x')`), /read-only transaction/);
  await dump.query('SET default_transaction_read_only = off');
  await assert.rejects(dump.query(`INSERT INTO board.audit_log (action) VALUES ('x')`), /permission denied/);
  await assert.rejects(dump.query('DELETE FROM board.post'), /permission denied/);
  await assert.rejects(dump.query('CREATE TABLE board.evil (x int)'), /permission denied/);
  await assert.rejects(dump.query('CREATE TABLE public.evil (x int)'), /permission denied/);
  await dump.end();
});

test('pg_dump as board_dump over the socket makes a custom-format archive of the board', () => {
  const run = dockerExec(db.passwords.board_dump, 'pg_dump', '--format=custom', '--no-password', '-h', '/var/run/postgresql', '-U', 'board_dump', '-d', 'board');
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(run.stdout.subarray(0, 5).toString(), 'PGDMP');
  const list = spawnSync('docker', ['exec', '-i', db.container, 'pg_restore', '-l'], {input: run.stdout, maxBuffer: 64 << 20});
  assert.equal(list.status, 0, String(list.stderr));
  const toc = list.stdout.toString();
  for (const entry of [/TABLE DATA board post /, /TABLE DATA board author /, /TABLE DATA board_meta migration /, /VIEW board visible_post /])
    assert.match(toc, entry);
  // No password, or a wrong one: no dump (scram-sha-256 on the local socket too).
  for (const password of [null, 'wrong-password-0123456789'])
    assert.notEqual(dockerExec(password, 'pg_dump', '--no-password', '-h', '/var/run/postgresql', '-U', 'board_dump', '-d', 'board', '--schema-only').status, 0);
});

test('the dump program can read the source identity without a superuser', async () => {
  const dump = await db.client('board_dump');
  const id = (await dump.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  assert.match(id, /^\d{10,20}$/);
  assert.match((await dump.query('SHOW server_version')).rows[0].server_version, /^18\./);
  await dump.end();
});
