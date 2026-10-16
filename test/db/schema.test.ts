// M1: append-only schema and role privileges, on a real Postgres (docker).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {startDb, type TestDb} from './pg.ts';
import {migrate} from '../../db/migrate.ts';

let db: TestDb;
before(async () => { db = await startDb(); });
after(() => db?.stop());

const hash = () => randomBytes(32);
async function person(c: pg.Client, login = 'alice'): Promise<string> {
  return (await c.query(`INSERT INTO board.author (kind, github_id, github_login, display_name) VALUES ('github', $1, $2, $2) RETURNING id`,
    [Math.floor(Math.random() * 1e9), login + randomBytes(2).toString('hex')])).rows[0].id;
}
async function denied(c: pg.Client, sql: string, params: unknown[] = []) {
  await assert.rejects(c.query(sql, params), (e: any) => /permission denied|must be owner/.test(e.message), sql);
}

test('migrations apply once; a rerun applies nothing', async () => {
  const owner = await db.client('board_owner');
  assert.deepEqual(await migrate(owner, {}), []);
  const boards = (await owner.query('SELECT count(*)::int AS n FROM board.board')).rows[0].n;
  assert.equal(boards, 20);   // 19 from 0003, directed-sssp from 0007
  await owner.end();
});

test('board_app: SELECT and INSERT post only; no UPDATE, DELETE, TRUNCATE, DDL, temp tables', async () => {
  const auth = await db.client('board_auth');
  const author = await person(auth);
  await auth.end();
  const app = await db.client('board_app');
  const post = (await app.query(`INSERT INTO board.post (board_slug, author_id, body, body_hash) VALUES ('3sum', $1, 'hello', $2) RETURNING id`, [author, hash()])).rows[0].id;
  assert.equal((await app.query('SELECT body FROM board.visible_post WHERE id = $1', [post])).rows[0].body, 'hello');
  await denied(app, `UPDATE board.post SET body = 'x' WHERE id = $1`, [post]);
  await denied(app, `DELETE FROM board.post WHERE id = $1`, [post]);
  await denied(app, 'TRUNCATE board.post');
  await denied(app, 'CREATE TABLE board.evil (x int)');
  await denied(app, 'CREATE TABLE public.evil (x int)');
  await denied(app, 'CREATE TEMP TABLE evil (x int)');
  await denied(app, `INSERT INTO board.ban (author_id, by_actor, reason) VALUES ($1, 'x', 'x')`, [author]);
  await denied(app, `INSERT INTO board.author (kind, github_id, github_login, display_name) VALUES ('github', 1, 'x', 'x')`);
  await denied(app, 'SELECT * FROM board.audit_log');
  await denied(app, 'ALTER TABLE board.post ADD COLUMN x int');
  await denied(app, 'DROP TABLE board.post');
  await app.end();
});

test('review fixes: INSERT is granted per column, so ids and times keep their defaults', async () => {
  const auth = await db.client('board_auth');
  const author = await person(auth);
  await denied(auth, `INSERT INTO board.session (token_hash, author_id, expires_at) VALUES ($1, $2, now() + interval '10 years')`, [hash(), author]);
  await denied(auth, `INSERT INTO board.author (id, kind, github_id, github_login, display_name) VALUES (gen_random_uuid(), 'github', 5, 'x', 'x')`);
  await denied(auth, `INSERT INTO board.audit_log (at, action) VALUES (now() - interval '1 year', 'x')`);
  await auth.end();
  const app = await db.client('board_app');
  await denied(app, `INSERT INTO board.post (board_slug, author_id, body, body_hash, created_at) VALUES ('3sum', $1, 'x', $2, now() - interval '2 hours')`, [author, hash()]);
  await denied(app, `INSERT INTO board.post (id, board_slug, author_id, body, body_hash) VALUES (gen_random_uuid(), '3sum', $1, 'x', $2)`, [author, hash()]);
  await app.end();
  const admin = await db.client('board_admin');
  await denied(admin, `INSERT INTO board.ban (author_id, by_actor, reason, at) VALUES ($1, 'x', 'x', now() - interval '1 day')`, [author]);
  await admin.end();
});

test('board_auth: writes accounts, keys and sessions, never posts or bans', async () => {
  const auth = await db.client('board_auth');
  const author = await person(auth);
  await denied(auth, `INSERT INTO board.post (board_slug, author_id, body, body_hash) VALUES ('3sum', $1, 'x', $2)`, [author, hash()]);
  await denied(auth, `INSERT INTO board.ban (author_id, by_actor, reason) VALUES ($1, 'x', 'x')`, [author]);
  await denied(auth, `UPDATE board.author SET display_name = 'x'`);
  await auth.end();
});

test('statement_timeout 2 s ends a long statement for every service role', async () => {
  for (const role of ['board_app', 'board_auth', 'board_admin'] as const) {
    const c = await db.client(role);
    assert.equal((await c.query('SHOW statement_timeout')).rows[0].statement_timeout, '2s');
    await assert.rejects(c.query('SELECT pg_sleep(3)'), /statement timeout/);
    await c.end();
  }
});

test('views: a hide, a ban of the owner and a key revocation take effect by new rows only', async () => {
  const auth = await db.client('board_auth');
  const owner = await person(auth, 'owner');
  const agent = (await auth.query(`INSERT INTO board.author (kind, display_name, owner_id) VALUES ('agent_key', 'bot', $1) RETURNING id`, [owner])).rows[0].id;
  const key = (await auth.query(`INSERT INTO board.api_key (author_id, owner_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4, 'k') RETURNING id`,
    [agent, owner, randomBytes(6).toString('hex'), hash()])).rows[0].id;
  await auth.end();
  const app = await db.client('board_app');
  const p1 = (await app.query(`INSERT INTO board.post (board_slug, author_id, key_id, body, body_hash) VALUES ('apsp', $1, $2, 'r1', $3) RETURNING id`, [agent, key, hash()])).rows[0].id;
  const p2 = (await app.query(`INSERT INTO board.post (board_slug, author_id, key_id, body, body_hash) VALUES ('apsp', $1, $2, 'r2', $3) RETURNING id`, [agent, key, hash()])).rows[0].id;
  const visible = async () => (await app.query('SELECT id FROM board.visible_post WHERE id = ANY($1)', [[p1, p2]])).rows.map(r => r.id).sort();
  const activeKey = async () => (await app.query('SELECT 1 FROM board.active_key WHERE id = $1', [key])).rowCount;
  assert.deepEqual(await visible(), [p1, p2].sort());
  const admin = await db.client('board_admin');
  await admin.query(`INSERT INTO board.hidden (post_id, by_actor, reason) VALUES ($1, 'nil', 'test')`, [p1]);
  assert.deepEqual(await visible(), [p2]);
  assert.equal(await activeKey(), 1);
  await admin.query(`INSERT INTO board.ban (author_id, by_actor, reason) VALUES ($1, 'nil', 'test')`, [owner]);
  assert.deepEqual(await visible(), []);
  assert.equal(await activeKey(), 0);
  await denied(admin, 'DELETE FROM board.ban');
  await admin.end(); await app.end();
});

test('constraints refuse oversized bodies and bad models', async () => {
  const auth = await db.client('board_auth');
  const author = await person(auth);
  await auth.end();
  const app = await db.client('board_app');
  const insert = (model: string | null, body: string) => app.query(
    `INSERT INTO board.post (board_slug, author_id, model, body, body_hash) VALUES ('3sum', $1, $2, $3, $4)`, [author, model, body, hash()]);
  await assert.rejects(insert(null, 'x'.repeat(4001)), /check constraint/);
  await assert.rejects(insert('https://spam.example', 'x'), /check constraint/);
  await assert.rejects(insert(null, ''), /check constraint/);
  await app.end();
});
