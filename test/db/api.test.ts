// M2 on a real Postgres: caps, repeats, concurrency, audit, reads, through the
// board_app role exactly as in production.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {startDb, type TestDb} from './pg.ts';
import {pgStore} from '../../src/store.ts';
import {bodyHash, mintKey, LIMITS} from '../../src/rules.ts';
import type {Actor, Store, Cursor, PostRow} from '../../src/api.ts';

let db: TestDb, pool: pg.Pool, store: Store, auth: pg.Client;
before(async () => {
  db = await startDb();
  pool = new pg.Pool({host: '127.0.0.1', port: db.port, database: 'board', user: 'board_app', password: db.passwords.board_app, max: 8});
  store = pgStore(pool);
  auth = await db.client('board_auth');
});
after(async () => { await auth?.end(); await pool?.end(); db?.stop(); });

async function person(): Promise<string> {
  const login = 'p' + randomBytes(4).toString('hex');
  return (await auth.query(`INSERT INTO board.author (kind, github_id, github_login, github_created_at, display_name) VALUES ('github', $1, $2, now() - interval '1 year', $2) RETURNING id`,
    [Math.floor(Math.random() * 1e12), login])).rows[0].id;
}
async function agentKey(owner: string): Promise<Actor> {
  const agent = (await auth.query(`INSERT INTO board.author (kind, display_name, owner_id) VALUES ('agent_key', 'bot', $1) RETURNING id`, [owner])).rows[0].id;
  const k = mintKey();
  const id = (await auth.query(`INSERT INTO board.api_key (author_id, owner_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4, 'k') RETURNING id`, [agent, owner, k.prefix, k.secretHash])).rows[0].id;
  return {authorId: agent, keyId: id, accountId: owner, label: 'key:' + k.prefix};
}
const post = (actor: Actor, board: string, body: string) => store.createPost(actor, {board, body, links: []}, bodyHash(body));
const uniq = () => 'post ' + randomBytes(6).toString('hex');
// Spread posts over boards so the 5/h per account per board cap does not apply.
const BOARDS = ['3sum', 'apsp', 'subset-sum', 'integer-multiplication', 'exact-dft', 'matrix-multiplication', 'other-snaky', 'other-catalan'];
const board = (i: number) => BOARDS[i % BOARDS.length];

test('per key cap: 10 posts per hour, then cap_key', async () => {
  const actor = await agentKey(await person());
  for (let i = 0; i < LIMITS.perKeyHour; i++) assert.equal((await post(actor, board(i), uniq())).ok, true);
  assert.deepEqual(await post(actor, board(10), uniq()), {ok: false, rule: 'cap_key'});
});

test('per account cap: 20 posts per hour across the account and its keys', async () => {
  const owner = await person();
  const [a, b] = [await agentKey(owner), await agentKey(owner)];
  const self: Actor = {authorId: owner, keyId: null, accountId: owner, label: 'author:' + owner};
  for (let i = 0; i < 10; i++) assert.equal((await post(a, board(i), uniq())).ok, true);
  for (let i = 0; i < 9; i++) assert.equal((await post(b, board(i + 3), uniq())).ok, true);
  assert.equal((await post(self, board(5), uniq())).ok, true);
  assert.deepEqual(await post(b, board(6), uniq()), {ok: false, rule: 'cap_account'});
});

test('per board cap: 60 posts per hour from many accounts (a board no other test uses)', async () => {
  for (let i = 0; i < 12; i++) {
    const actor = await agentKey(await person());
    for (let j = 0; j < 5; j++) assert.equal((await post(actor, 'other-heilbronn-triangle', uniq())).ok, true);
  }
  const late = await agentKey(await person());
  assert.deepEqual(await post(late, 'other-heilbronn-triangle', uniq()), {ok: false, rule: 'cap_board'});
  assert.equal((await post(late, 'exact-dft', uniq())).ok, true);
});

test('concurrent posts with one key cannot pass the cap together', async () => {
  const actor = await agentKey(await person());
  const results = await Promise.all(Array.from({length: 15}, (_, i) => post(actor, board(i), uniq())));
  assert.equal(results.filter(r => r.ok).length, 10);
  assert.equal(results.filter(r => !r.ok && r.rule === 'cap_key').length, 5);
});

test('per account per board cap: 5 posts per hour on one board across all keys', async () => {
  const owner = await person();
  const [a, b] = [await agentKey(owner), await agentKey(owner)];
  for (let i = 0; i < 3; i++) assert.equal((await post(a, 'other-haldane-gap', uniq())).ok, true);
  for (let i = 0; i < 2; i++) assert.equal((await post(b, 'other-haldane-gap', uniq())).ok, true);
  assert.deepEqual(await post(a, 'other-haldane-gap', uniq()), {ok: false, rule: 'cap_account_board'});
  assert.deepEqual(await post(b, 'other-haldane-gap', uniq()), {ok: false, rule: 'cap_account_board'});
  assert.equal((await post(b, 'other-sidorenko', uniq())).ok, true);
});

test('repeat: same author within 24 h, or any author on the board within 1 h', async () => {
  const a = await agentKey(await person()), b = await agentKey(await person());
  assert.equal((await post(a, 'matrix-multiplication', 'Bound 2.371 improved')).ok, true);
  assert.deepEqual(await post(a, 'matrix-multiplication', 'bound 2.371   IMPROVED!'), {ok: false, rule: 'repeat'});
  assert.deepEqual(await post(b, 'matrix-multiplication', 'Bound 2.371 improved'), {ok: false, rule: 'repeat'});
  assert.deepEqual(await post(a, 'integer-multiplication', 'Bound 2.371 improved'), {ok: false, rule: 'repeat'});
  assert.equal((await post(b, 'integer-multiplication', 'Bound 2.371 improved')).ok, true);
});

test('unknown board is refused; accepted posts are audited', async () => {
  const actor = await agentKey(await person());
  assert.deepEqual(await post(actor, 'no-such-board', uniq()), {ok: false, rule: 'unknown_board'});
  const r = await post(actor, 'other-snaky', uniq());
  assert.ok(r.ok);
  const admin = await db.client('board_admin');
  const row = (await admin.query(`SELECT actor, action FROM board.audit_log WHERE target = $1`, [(r as any).id])).rows[0];
  assert.deepEqual(row, {actor: actor.label, action: 'post.create'});
  await store.audit([{actor: null, action: 'post.create', rule: 'kill_switch', target: null, count: 7}]);
  assert.equal((await admin.query(`SELECT sum(count)::int AS n FROM board.audit_log WHERE rule = 'kill_switch'`)).rows[0].n, 7);
  await admin.end();
});

test('read: newest first with before=, oldest first with after=, no repeats; hidden and banned posts disappear', async () => {
  const owner = await person();
  const actor = await agentKey(owner), other = await agentKey(await person());
  const ids: string[] = [];
  // Two accounts alternate (4 + 3 posts), within the 5/h per account per board cap.
  for (let i = 0; i < 7; i++) ids.push(((await post(i % 2 ? other : actor, 'other-ordered-matrix-removal', uniq())) as any).id);
  const cursorOf = (p: PostRow): Cursor => ({at: p.cursor.slice(0, p.cursor.lastIndexOf('_')), id: p.id});
  const walk = async (dir: 'after' | 'before', start: Cursor | undefined) => {
    const seen: string[] = [];
    let cursor = start;
    for (;;) {
      const page: PostRow[] = (await store.listPosts('other-ordered-matrix-removal', cursor ? {[dir]: cursor} : {}, 3))!;
      seen.push(...page.map(p => p.id));
      if (page.length < 3) return seen;
      cursor = cursorOf(page.at(-1)!);
    }
  };
  assert.deepEqual(await walk('before', undefined), [...ids].reverse());
  const first = (await store.listPosts('other-ordered-matrix-removal', {before: undefined}, 50))!.at(-1)!;
  assert.deepEqual(await walk('after', cursorOf(first)), ids.slice(1));
  assert.equal((await store.listPosts('nope', {}, 5)), null);
  const admin = await db.client('board_admin');
  await admin.query(`INSERT INTO board.hidden (post_id, by_actor, reason) VALUES ($1, 'nil', 'spam')`, [ids[0]]);
  assert.equal((await store.listPosts('other-ordered-matrix-removal', {}, 50))!.length, 6);
  await admin.query(`INSERT INTO board.ban (author_id, by_actor, reason) VALUES ($1, 'nil', 'spam')`, [owner]);
  assert.equal((await store.listPosts('other-ordered-matrix-removal', {}, 50))!.length, 3); // the other account's posts stay
  assert.equal(await store.keyByPrefix(actor.label.slice(4)), null);
  await admin.end();
});
