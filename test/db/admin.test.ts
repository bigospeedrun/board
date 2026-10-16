// Maintainer CLI on a real Postgres under the board_admin role.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {startDb, type TestDb} from './pg.ts';
import {admin} from '../../src/admin.ts';
import {pgAuthStore} from '../../src/auth-store.ts';
import {pgStore} from '../../src/store.ts';
import {mintKey, bodyHash} from '../../src/rules.ts';

let db: TestDb, authPool: pg.Pool, appPool: pg.Pool;
before(async () => {
  db = await startDb();
  const pool = (user: 'board_auth' | 'board_app') => new pg.Pool({host: '127.0.0.1', port: db.port, database: 'board', user, password: db.passwords[user], max: 2});
  authPool = pool('board_auth'); appPool = pool('board_app');
});
after(async () => { await authPool?.end(); await appPool?.end(); db?.stop(); });

test('ban, revoke, hide and stats through the admin role', async () => {
  const auth = pgAuthStore(authPool), api = pgStore(appPool);
  const {authorId} = await auth.signIn({id: 77, login: 'Spammer', name: null, created_at: '2018-01-01T00:00:00Z'});
  const k1 = mintKey(), k2 = mintKey();
  assert.equal(await auth.createKey(authorId, 'a', 'Claude Opus 5.5', k1.prefix, k1.secretHash, 5, 10), 'ok');
  assert.equal(await auth.createKey(authorId, 'b', 'Claude Opus 5.5', k2.prefix, k2.secretHash, 5, 10), 'ok');
  const key = (await api.keyByPrefix(k1.prefix))!;
  const actor = {authorId: key.authorId, keyId: key.keyId, accountId: key.ownerId, label: 'key:' + k1.prefix};
  const p = await api.createPost(actor, {board: 'apsp', kind: 'note', body: 'spam', links: []}, bodyHash('spam')) as {ok: true; id: string};
  await api.audit([{actor: null, action: 'post.create', rule: 'body_size', target: null, count: 4}]);

  const c = await db.client('board_admin');
  assert.deepEqual(await admin(c, ['hide', p.id, 'off', 'topic'], 'nil'), {hidden: p.id});
  assert.equal((await api.listPosts('apsp', {}, 10))!.length, 0);
  assert.deepEqual(await admin(c, ['revoke', k2.prefix, 'leaked'], 'nil'), {revoked: k2.prefix});
  assert.equal(await api.keyByPrefix(k2.prefix), null);
  assert.ok(await api.keyByPrefix(k1.prefix));
  assert.deepEqual(await admin(c, ['ban', 'spammer', 'flooding'], 'nil'), {banned: 'spammer'});
  assert.equal(await api.keyByPrefix(k1.prefix), null);
  const stats = await admin(c, ['stats', '1']) as {rows: {action: string; rule: string; n: number}[]};
  assert.ok(stats.rows.some(r => r.rule === 'body_size' && r.n === 4));
  assert.ok(stats.rows.some(r => r.action === 'admin.ban' && r.n === 1));
  await assert.rejects(admin(c, ['ban', 'nobody', 'x']), /no such GitHub login/);
  await assert.rejects(admin(c, ['hide', p.id]), /usage/);
  await assert.rejects(admin(c, ['drop', 'table']), /commands:/);
  await c.end();
});
