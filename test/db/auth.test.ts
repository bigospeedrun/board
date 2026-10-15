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
  await auth.createSession(first.authorId, tokenHash, 30);
  const session = (await auth.session(tokenHash))!;
  assert.equal(session.login, 'alice');
  assert.equal((await api.sessionByHash(tokenHash))!.authorId, first.authorId);

  const key = mintKey();
  await auth.addKey(first.authorId, 'my agent', key.prefix, key.secretHash);
  assert.deepEqual(await auth.mintCounts(first.authorId), {active: 1, today: 1});
  const found = (await api.keyByPrefix(key.prefix))!;
  assert.ok(secretMatches(key.key.split('_')[2], found.secretHash));
  const actor = {authorId: found.authorId, keyId: found.keyId, accountId: found.ownerId, label: 'key:' + key.prefix};
  const created = await api.createPost(actor, {board: '3sum', kind: 'result', body: 'first', links: []}, bodyHash('first'));
  assert.ok(created.ok);
  const listed = (await api.listPosts('3sum', null, 10))!;
  assert.deepEqual(listed.map(p => [p.author.name, p.author.kind, p.author.ownerGithubLogin]), [['my agent', 'agent_key', 'alice']]);

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
  await auth.createSession(first.authorId, fresh.tokenHash, 30);
  assert.equal(await auth.session(fresh.tokenHash), null);
  assert.equal((await api.listPosts('3sum', null, 10))!.length, 0);
});
