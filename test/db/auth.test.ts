// M3 on a real Postgres: board-auth store under the board_auth role, end to end
// with the board-api store (sign in -> mint -> post -> revoke -> ban).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {startDb, type TestDb} from './pg.ts';
import {pgAuthStore} from '../../src/auth-store.ts';
import {pgStore} from '../../src/store.ts';
import {mintKey, newSessionToken, bodyHash, secretMatches} from '../../src/rules.ts';

let db: TestDb, authPool: pg.Pool, appPool: pg.Pool;
before(async () => {
  db = await startDb();
  const pool = (user: 'board_auth' | 'board_app') => new pg.Pool({host: '127.0.0.1', port: db.port, database: 'board', user, password: db.passwords[user], max: 3});
  authPool = pool('board_auth'); appPool = pool('board_app');
});
after(async () => { await authPool?.end(); await appPool?.end(); db?.stop(); });

test('sign in, session, mint, post, revoke, end session, ban', async () => {
  const auth = pgAuthStore(authPool), api = pgStore(appPool);
  const user = {id: 9001, login: 'alice', name: 'Alice', created_at: '2019-05-01T00:00:00Z'};
  const first = await auth.signIn(user);
  assert.deepEqual(await auth.signIn({...user, login: 'alice-renamed'}), first);
  assert.equal(first.banned, false);

  const {tokenHash} = newSessionToken();
  await auth.createSession(first.authorId, tokenHash);
  const session = (await auth.session(tokenHash))!;
  assert.equal(session.login, 'alice');
  assert.equal((await api.sessionByHash(tokenHash))!.authorId, first.authorId);

  const key = mintKey();
  assert.equal(await auth.createKey(first.authorId, 'my agent', 'Claude Opus 5.5', key.prefix, key.secretHash, 5, 10), 'ok');
  const found = (await api.keyByPrefix(key.prefix))!;
  assert.ok(secretMatches(key.key.slice('bos_'.length + 12 + 1), found.secretHash)); // the secret itself can contain '_'
  const actor = {authorId: found.authorId, keyId: found.keyId, accountId: found.ownerId, label: 'key:' + key.prefix};
  const created = await api.createPost(actor, {board: '3sum', body: 'first', links: []}, bodyHash('first'));
  assert.ok(created.ok);
  const listed = (await api.listPosts('3sum', {}, 10))!;
  assert.deepEqual(listed.map(p => [p.author.name, p.author.kind, p.author.ownerGithubLogin, p.author.model]),
    [['my agent', 'agent_key', 'alice', {label: 'Claude Opus 5.5', selfReported: true}]]);
  assert.equal((await auth.keys(first.authorId))[0].model, 'Claude Opus 5.5');
  // A post by the person shows "human", not self-reported.
  const self = {authorId: first.authorId, keyId: null, accountId: first.authorId, label: 'author:' + first.authorId};
  assert.ok((await api.createPost(self, {board: '3sum', body: 'by hand', links: []}, bodyHash('by hand'))).ok);
  assert.deepEqual((await api.listPosts('3sum', {}, 1))![0].author.model, {label: 'human', selfReported: false});

  assert.equal(await auth.revokeKey(first.authorId, key.prefix, 'author:' + first.authorId), true);
  assert.equal(await auth.revokeKey(first.authorId, key.prefix, 'again'), true);
  assert.equal(await api.keyByPrefix(key.prefix), null);
  assert.equal((await auth.keys(first.authorId))[0].revoked, true);
  assert.equal(await auth.revokeKey(first.authorId, 'ffffffffffff', 'x'), false);

  await auth.endSession(session.sessionId);
  assert.equal(await auth.session(tokenHash), null);

  const admin = await db.client('board_admin');
  await admin.query(`INSERT INTO board.ban (author_id, by_actor, reason) VALUES ($1, 'nil', 'test')`, [first.authorId]);
  await admin.end();
  assert.equal((await auth.signIn(user)).banned, true);
  const fresh = newSessionToken();
  await auth.createSession(first.authorId, fresh.tokenHash);
  assert.equal(await auth.session(fresh.tokenHash), null);
  assert.equal((await api.listPosts('3sum', {}, 10))!.length, 0);
});

test('model label: stored on the agent author row, fixed after mint, checked by the database too', async () => {
  const auth = pgAuthStore(authPool), api = pgStore(appPool);
  const {authorId} = await auth.signIn({id: 9300, login: 'modeller', name: null, created_at: '2019-01-01T00:00:00Z'});
  const k = mintKey();
  assert.equal(await auth.createKey(authorId, 'bot', 'GPT-5.1 Codex', k.prefix, k.secretHash, 5, 10), 'ok');
  const found = (await api.keyByPrefix(k.prefix))!;
  const c = await db.client('board_auth');
  // board_auth cannot change it (no UPDATE), and the CHECK refuses a link, a long value
  // and a model on a person row.
  await assert.rejects(c.query(`UPDATE board.author SET model = 'x' WHERE id = $1`, [found.authorId]), /permission denied/);
  const agent = (model: string) => c.query(`INSERT INTO board.author (kind, display_name, owner_id, model) VALUES ('agent_key', 'x', $1, $2)`, [authorId, model]);
  for (const bad of ['https://evil.example', 'a/b', '<b>', 'x'.repeat(41), 'a\nb', '[x](y)'])
    await assert.rejects(agent(bad), /check constraint/, bad);
  await agent('Claude Opus 5.5');
  await assert.rejects(c.query(`INSERT INTO board.author (kind, github_id, github_login, display_name, model) VALUES ('github', 9301, 'p9301', 'p', 'human')`), /check constraint/);
  await c.end();
});

test('review fixes: concurrent mints by one owner cannot pass the key caps together', async () => {
  const auth = pgAuthStore(authPool);
  const {authorId} = await auth.signIn({id: 9100, login: 'minter', name: 'Minter', created_at: '2019-01-01T00:00:00Z'});
  const results = await Promise.all(Array.from({length: 8}, () => { const k = mintKey(); return auth.createKey(authorId, 'k', 'm', k.prefix, k.secretHash, 5, 10); }));
  assert.equal(results.filter(r => r === 'ok').length, 5);
  assert.equal(results.filter(r => r === 'cap_keys_active').length, 3);
});

test('review fixes: sessions expire by the 30-day DB default; display names are sanitized', async () => {
  const auth = pgAuthStore(authPool);
  const {authorId} = await auth.signIn({id: 9200, login: 'bidi-user', name: 'evil\u202ename', created_at: '2019-01-01T00:00:00Z'});
  const {tokenHash} = newSessionToken();
  await auth.createSession(authorId, tokenHash);
  const owner = await db.client('board_owner');
  const row = (await owner.query(`SELECT (expires_at - created_at) = interval '30 days' AS thirty FROM board.session WHERE token_hash = $1`, [tokenHash])).rows[0];
  assert.equal(row.thirty, true);
  assert.equal((await owner.query('SELECT display_name FROM board.author WHERE id = $1', [authorId])).rows[0].display_name, 'bidi-user');
  await owner.end();
});
