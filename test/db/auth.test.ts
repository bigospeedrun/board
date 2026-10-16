// M3 on a real Postgres: board-auth store under the board_auth role, end to end
// with the board-api store (sign in -> mint -> post -> revoke -> ban).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {startDb, type TestDb} from './pg.ts';
import {pgAuthStore} from '../../src/auth-store.ts';
import {pgStore} from '../../src/store.ts';
import {createServer} from 'node:http';
import {mintKey, newSessionToken, bodyHash, secretMatches, sha256, configFrom} from '../../src/rules.ts';
import {createAuth, type Challenge} from '../../src/auth.ts';

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
  assert.equal(await auth.createKey(first.authorId, 'my agent', key.prefix, key.secretHash, 5, 10), 'ok');
  const found = (await api.keyByPrefix(key.prefix))!;
  assert.ok(secretMatches(key.key.slice('bos_'.length + 12 + 1), found.secretHash)); // the secret itself can contain '_'
  const actor = {authorId: found.authorId, keyId: found.keyId, accountId: found.ownerId, label: 'key:' + key.prefix};
  const created = await api.createPost(actor, {board: '3sum', body: 'first', model: 'Claude Opus 5.5'}, bodyHash('first'));
  assert.ok(created.ok);
  const listed = (await api.listPosts('3sum', {}, 10))!;
  assert.deepEqual(listed.map(p => [p.author.name, p.author.kind, p.author.ownerGithubLogin, p.model]),
    [['my agent', 'agent_key', 'alice', {label: 'Claude Opus 5.5', selfReported: true}]]);
  assert.deepEqual(Object.keys((await auth.keys(first.authorId))[0]).sort(), ['createdAt', 'label', 'prefix', 'revoked']);
  // A post by the person shows "human", not self-reported.
  const self = {authorId: first.authorId, keyId: null, accountId: first.authorId, label: 'author:' + first.authorId};
  assert.ok((await api.createPost(self, {board: '3sum', body: 'by hand'}, bodyHash('by hand'))).ok);
  assert.deepEqual((await api.listPosts('3sum', {}, 1))![0].model, {label: 'human', selfReported: false});

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

test('post model (migration 0006): per post, one key can post with two models, checked by the database too', async () => {
  const auth = pgAuthStore(authPool), api = pgStore(appPool);
  const {authorId} = await auth.signIn({id: 9300, login: 'modeller', name: null, created_at: '2019-01-01T00:00:00Z'});
  const k = mintKey();
  assert.equal(await auth.createKey(authorId, 'swarm', k.prefix, k.secretHash, 5, 10), 'ok');
  const found = (await api.keyByPrefix(k.prefix))!;
  const actor = {authorId: found.authorId, keyId: found.keyId, accountId: found.ownerId, label: 'key:' + k.prefix};
  for (const [body, model] of [['m one', 'GPT-5.1 Codex'], ['m two', 'Claude Opus 5.5'], ['m three', null]] as const)
    assert.ok((await api.createPost(actor, {board: 'apsp', body, model}, bodyHash(body))).ok);
  assert.deepEqual((await api.listPosts('apsp', {}, 3))!.map(p => p.model.label), [null, 'Claude Opus 5.5', 'GPT-5.1 Codex']);
  // The agent author row has no model any more; the CHECK on post.model refuses links and markup.
  const owner = await db.client('board_owner');
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'board' AND table_name = 'author' AND column_name = 'model'`)).rows[0].n, 0);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'board' AND table_name = 'post' AND column_name = 'kind'`)).rows[0].n, 0);
  for (const bad of ['https://evil.example', 'a/b', '<b>', 'x'.repeat(41), 'a\nb', '[x](y)'])
    await assert.rejects(owner.query(`INSERT INTO board.post (board_slug, author_id, model, body, body_hash) VALUES ('apsp', $1, $2, 'x', $3)`, [found.authorId, bad, Buffer.alloc(32, 1)]), /check constraint/, bad);
  await owner.end();
  // board_app may write the model column, and only on insert.
  const app = await db.client('board_app');
  await assert.rejects(app.query(`UPDATE board.post SET model = 'x'`), /permission denied/);
  await app.end();
});

test('review fixes: concurrent mints by one owner cannot pass the key caps together', async () => {
  const auth = pgAuthStore(authPool);
  const {authorId} = await auth.signIn({id: 9100, login: 'minter', name: 'Minter', created_at: '2019-01-01T00:00:00Z'});
  const results = await Promise.all(Array.from({length: 8}, () => { const k = mintKey(); return auth.createKey(authorId, 'k', k.prefix, k.secretHash, 5, 10); }));
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

test('agent challenge (migration 0008): board_auth stores a challenge with a fixed 10-minute expiry; it is used once', async () => {
  const auth = pgAuthStore(authPool);
  const nonceHash = sha256('nonce-for-test');
  const c = await auth.createChallenge('Gist-User', 'proof-search', nonceHash, 'bos-board-0123456789abcdef.txt');
  assert.equal(c.expiresAt.getTime() - c.createdAt.getTime(), 600_000);
  // Two verifies at once: only one gets the challenge.
  const uses = await Promise.all([auth.useChallenge(c.id), auth.useChallenge(c.id), auth.useChallenge(c.id)]);
  const got = uses.filter(u => typeof u === 'object') as Challenge[];
  assert.equal(got.length, 1); assert.equal(uses.filter(u => u === 'used').length, 2);
  assert.deepEqual([got[0].login, got[0].agentName, got[0].filename], ['Gist-User', 'proof-search', 'bos-board-0123456789abcdef.txt']);
  assert.deepEqual(got[0].nonceHash, nonceHash); assert.ok(got[0].createdAt instanceof Date);
  assert.equal(await auth.useChallenge('00000000-0000-4000-8000-000000000000'), 'unknown');
  // An expired one (made by the owner role, which may set expires_at).
  const owner = await db.client('board_owner');
  const old = (await owner.query(`INSERT INTO board.agent_challenge (github_login, agent_name, nonce_hash, filename, created_at, expires_at)
    VALUES ('x', 'y', $1, 'bos-board-00000000000000ff.txt', now() - interval '11 minutes', now() - interval '1 minute') RETURNING id`, [nonceHash])).rows[0].id;
  assert.equal(await auth.useChallenge(old), 'expired');
  for (const [login, file] of [['bad login!', 'bos-board-0123456789abcdef.txt'], ['ok', '../etc/passwd']])
    await assert.rejects(owner.query(`INSERT INTO board.agent_challenge (github_login, agent_name, nonce_hash, filename) VALUES ($1, 'y', $2, $3)`, [login, nonceHash, file]), /check constraint/);
  await owner.end();
  // board_auth: insert on named columns only, no update or delete; board_app cannot read it.
  const raw = await db.client('board_auth');
  for (const sql of [`INSERT INTO board.agent_challenge (github_login, agent_name, nonce_hash, filename, expires_at) VALUES ('x', 'y', '\\x${'00'.repeat(32)}', 'bos-board-0123456789abcdef.txt', now() + interval '1 year')`,
      `UPDATE board.agent_challenge SET expires_at = now() + interval '1 year'`, `DELETE FROM board.agent_challenge_use`,
      `INSERT INTO board.agent_challenge_use (challenge_id, at) VALUES ('${c.id}', now())`])
    await assert.rejects(raw.query(sql), /permission denied/, sql);
  await raw.end();
  const app = await db.client('board_app');
  await assert.rejects(app.query('SELECT 1 FROM board.agent_challenge'), /permission denied/);
  await app.end();
  const dump = await db.client('board_dump');
  assert.equal((await dump.query('SELECT count(*)::int AS n FROM board.agent_challenge_use')).rows[0].n, 1);
  await dump.end();
});

test('agent verify end to end on Postgres: the mint for a gist owner is a normal key of that account', async () => {
  const auth = pgAuthStore(authPool), api = pgStore(appPool);
  const store = auth;
  const user = {id: 9400, login: 'gist-owner', name: 'Gist Owner', created_at: '2019-01-01T00:00:00Z'};
  const nonce = 'n'.repeat(43);
  const s = createServer(createAuth(store, {
    exchange: async () => { throw new Error('unused'); }, user: async () => { throw new Error('unused'); },
    gist: async () => ({ownerLogin: 'Gist-Owner', ownerId: 9400, createdAt: new Date().toISOString(), files: {[filename]: {content: nonce, truncated: false}}}),
    userById: async () => user,
  }, configFrom({}), {clientId: 'Ov23test000000', stateSecret: Buffer.from('state-secret-for-tests-only-0123456789')}));
  let filename = '';
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(s.address() as any).port}/auth/agent/`;
  const post = (path: string, body: object) => fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  try {
    const ch = await (await post('challenge', {github_login: 'gist-owner', agent_name: 'gist agent'})).json();
    // Our fake gist must hold the nonce the board gave; swap it in.
    filename = ch.filename;
    const owner = await db.client('board_owner');
    await owner.query('UPDATE board.agent_challenge SET nonce_hash = $1 WHERE id = $2', [sha256(nonce), ch.challenge_id]);
    const r = await post('verify', {challenge_id: ch.challenge_id, gist_id: 'a'.repeat(32)});
    assert.equal(r.status, 201);
    const minted = await r.json();
    const found = (await api.keyByPrefix(minted.prefix))!;
    const authorId = (await auth.signIn(user)).authorId;
    assert.equal(found.ownerId, authorId);
    assert.deepEqual((await auth.keys(authorId)).map(k => k.label), ['gist agent']);
    assert.ok(secretMatches(minted.key.slice('bos_'.length + 12 + 1), found.secretHash));
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM board.audit_log WHERE action = 'key.mint_gist' AND target = $1`, [minted.prefix])).rows[0].n, 1);
    await owner.end();
    assert.equal((await post('verify', {challenge_id: ch.challenge_id, gist_id: 'a'.repeat(32)})).status, 409);
  } finally { s.close(); }
});
