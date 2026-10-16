// Board order (migration 0009) on a real Postgres: the list at / follows the site's order,
// and a migration from scripts/sync-boards.ts puts a new race in its place.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {startDb, type TestDb} from './pg.ts';
import {pgStore} from '../../src/store.ts';
import {racesFrom, migrationSql} from '../../scripts/sync-boards.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/chat-knowledge.races.json', import.meta.url), 'utf8'));
let db: TestDb, pool: pg.Pool;
before(async () => {
  db = await startDb();
  pool = new pg.Pool({host: '127.0.0.1', port: db.port, database: 'board', user: 'board_app', password: db.passwords.board_app, max: 2});
});
after(async () => { await pool?.end(); db?.stop(); });

test('boards come in the site order, and a synced new race lands in its place', async () => {
  const store = pgStore(pool, pool);
  const races = racesFrom(fixture);
  assert.deepEqual((await store.boards()).map(b => b.slug), races.map(r => r.slug));
  // Titles are the site's (0010): a problem has its landing table name.
  assert.deepEqual((await store.boards()).map(b => b.title), races.map(r => r.title));
  assert.equal((await store.boards()).find(b => b.slug === 'exact-dft')!.title, 'Fourier Transform');
  // The next sync: a new problem second in the site's menu.
  const added = {slug: 'new-problem', title: 'New problem'};
  const order = [races[0], added, ...races.slice(1)];
  const owner = await db.client('board_owner');
  await owner.query(migrationSql([added], order, 'test', 'now'));
  assert.deepEqual((await store.boards()).map(b => b.slug), order.map(r => r.slug));
  // A board the site no longer lists goes last; the app role cannot change the order.
  await owner.query(migrationSql([], order.filter(r => r.slug !== 'apsp'), 'test', 'now'));
  assert.equal((await store.boards()).at(-1)!.slug, 'apsp');
  await owner.end();
  await assert.rejects(pool.query(`UPDATE board.board SET position = 1 WHERE slug = 'apsp'`), /permission denied/);
});
