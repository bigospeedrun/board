// Plan regression: no hot query may turn into a sequential scan on post (or on the
// other large tables) on a seeded board. docs/queries.md has the full plans at 1M posts.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {startDb, type TestDb} from './pg.ts';
import {seed, type Seeded} from './seed.ts';
import {SQL} from '../../src/store.ts';
import {AUTH_SQL} from '../../src/auth-store.ts';

const LARGE = new Set(['post', 'author', 'api_key', 'session']);
let db: TestDb, s: Seeded, app: pg.Client, auth: pg.Client;
before(async () => {
  db = await startDb();
  const owner = await db.client('board_owner');
  s = await seed(owner, 200_000);
  await owner.end();
  app = await db.client('board_app'); auth = await db.client('board_auth');
});
after(async () => { await app?.end(); await auth?.end(); db?.stop(); });

function seqScans(node: any, found: string[] = []): string[] {
  if (node['Node Type'] === 'Seq Scan' && LARGE.has(node['Relation Name'])) found.push(node['Relation Name']);
  for (const child of node.Plans ?? []) seqScans(child, found);
  return found;
}
async function assertIndexed(client: pg.Client, name: string, sql: string, params: unknown[]) {
  const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0].Plan;
  const scans = seqScans(plan);
  assert.deepEqual(scans, [], `${name}: sequential scan on ${scans.join(', ')}\n${JSON.stringify(plan).slice(0, 3000)}`);
}

test('board-api hot queries use indexes', async () => {
  const caps = [s.keyId, s.accountId, s.hotBoard, s.bodyHash, s.agentId, 24, 1, 10, 20, 60];
  await assertIndexed(app, 'keyByPrefix', SQL.keyByPrefix, [s.keyPrefix]);
  await assertIndexed(app, 'sessionByHash', SQL.sessionByHash, [s.sessionHash]);
  await assertIndexed(app, 'capsAndRepeat hot', SQL.capsAndRepeat, caps);
  await assertIndexed(app, 'capsAndRepeat quiet', SQL.capsAndRepeat, [...caps.slice(0, 2), s.coldBoard, ...caps.slice(3)]);
  await assertIndexed(app, 'capsAndRepeat person', SQL.capsAndRepeat, [null, s.accountId, s.hotBoard, s.bodyHash, s.accountId, 24, 1, 10, 20, 60]);
  await assertIndexed(app, 'feedNewest hot', SQL.feedNewest, [s.hotBoard, null, null, 50]);
  await assertIndexed(app, 'feedNewest quiet', SQL.feedNewest, [s.coldBoard, null, null, 50]);
  await assertIndexed(app, 'feedNewest deep', SQL.feedNewest, [s.hotBoard, s.deepCursor.at, s.deepCursor.id, 50]);
  await assertIndexed(app, 'feedAfter', SQL.feedAfter, ['apsp', s.recentCursor.at, s.recentCursor.id, 50]);
});

test('board-auth hot queries use indexes', async () => {
  await assertIndexed(auth, 'authorByGithubId', AUTH_SQL.authorByGithubId, [7]);
  await assertIndexed(auth, 'session', AUTH_SQL.session, [s.sessionHash]);
  await assertIndexed(auth, 'keys', AUTH_SQL.keys, [s.accountId]);
  await assertIndexed(auth, 'mintCounts', AUTH_SQL.mintCounts, [s.accountId]);
  await assertIndexed(auth, 'keyOfOwner', AUTH_SQL.keyOfOwner, [s.accountId, s.keyPrefix]);
});

test('the guard detects a sequential scan on post', async () => {
  const plan = (await app.query(`EXPLAIN (FORMAT JSON) SELECT count(*) FROM board.post WHERE kind = 'note'`)).rows[0]['QUERY PLAN'][0].Plan;
  assert.ok(seqScans(plan).includes('post'));
});
