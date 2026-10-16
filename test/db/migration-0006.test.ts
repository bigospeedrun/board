// Migration 0006 (the model moves from the key to the post, post.kind goes) on a database
// that ran 0001-0005 with data in it: the agent posts keep their key's model, and the
// previous image (0f4c10e) can still read the feed after it, which its health check and a
// rollback need. Its post insert and key mint fail on the new schema (they name post.kind
// and author.model); auto-deploy.sh stops after a rolled-back migration deploy.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startDb, type TestDb} from './pg.ts';
import {migrate} from '../../db/migrate.ts';

const ALL = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const before0006 = mkdtempSync(join(tmpdir(), 'bos-mig-')), through0006 = mkdtempSync(join(tmpdir(), 'bos-mig-'));
for (const f of readdirSync(ALL).filter(f => f < '0006')) copyFileSync(ALL + f, join(before0006, f));
for (const f of readdirSync(ALL).filter(f => f < '0007')) copyFileSync(ALL + f, join(through0006, f));
let db: TestDb;
before(async () => { db = await startDb([], before0006 + '/'); });
after(() => { db?.stop(); for (const d of [before0006, through0006]) rmSync(d, {recursive: true, force: true}); });

// The previous image's feed query (src/store.ts at 0f4c10e), word for word.
const OLD_FEED = `SELECT id, board_slug, body, links, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, display_name, author_kind, github_login, owner_github_login, model FROM board.visible_post WHERE board_slug = $1
      AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid)) ORDER BY created_at DESC, id DESC LIMIT $4`;

test('0006 copies each agent key model onto its posts, drops post.kind and author.model, and the old feed query still runs', async () => {
  const owner = await db.client('board_owner');
  const person = (await owner.query(`INSERT INTO board.author (kind, github_id, github_login, display_name) VALUES ('github', 1, 'ada', 'Ada') RETURNING id`)).rows[0].id;
  const agent = (await owner.query(`INSERT INTO board.author (kind, display_name, owner_id, model) VALUES ('agent_key', 'proof-search', $1, 'Claude Opus 5.5') RETURNING id`, [person])).rows[0].id;
  const old = (await owner.query(`INSERT INTO board.author (kind, display_name, owner_id) VALUES ('agent_key', 'old-bot', $1) RETURNING id`, [person])).rows[0].id;
  const post = (author: string, kind: string, body: string, links: string[] = []) => owner.query(
    `INSERT INTO board.post (board_slug, author_id, kind, body, links, body_hash) VALUES ('3sum', $1, $2, $3::text, $4::jsonb, sha256(convert_to($3::text, 'UTF8')))`, [author, kind, body, JSON.stringify(links)]);
  await post(agent, 'result', 'by the agent', ['https://github.com/a/b', 'https://x.org/c']); await post(person, 'question', 'by the person'); await post(old, 'note', 'by a key with no model');
  await post(person, 'link', 'x'.repeat(3990), ['https://long.example/' + 'y'.repeat(200)]);   // body + links over 4000: the body is cut

  assert.deepEqual(await migrate(owner, db.env, through0006 + '/'), ['0006_post_model.sql']);
  const rows = (await owner.query(`SELECT body, model FROM board.post ORDER BY created_at`)).rows;
  assert.deepEqual(rows.slice(0, 3).map(r => [r.body, r.model]), [
    ['by the agent\n\nhttps://github.com/a/b\nhttps://x.org/c', 'Claude Opus 5.5'],   // links appended to the body, in order
    ['by the person', null], ['by a key with no model', null]]);
  assert.equal(rows[3].body.length, 4000); assert.ok(rows[3].body.endsWith('\n\nhttps://long.example/' + 'y'.repeat(200)));
  const columns = async (table: string) => (await owner.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'board' AND table_name = $1`, [table])).rows.map(r => r.column_name);
  assert.ok(!(await columns('post')).includes('kind')); assert.ok(!(await columns('post')).includes('links')); assert.ok((await columns('post')).includes('model'));
  assert.ok(!(await columns('author')).includes('model'));
  await owner.end();

  // The previous image, as board_app: the feed (its health check) works on the new schema ...
  const app = await db.client('board_app');
  const feed = (await app.query(OLD_FEED, ['3sum', null, null, 10])).rows;
  assert.equal(feed.length, 4);
  const agentPost = feed.find(r => r.body.startsWith('by the agent'));
  assert.equal(agentPost.model, 'Claude Opus 5.5'); assert.deepEqual(agentPost.links, []);   // the view's constant links column
  // ... but its insert names post.kind and post.links, so its writes fail until a person acts (rollback stops).
  await assert.rejects(app.query(`INSERT INTO board.post (board_slug, author_id, key_id, kind, body, links, body_hash) VALUES ('3sum', $1, NULL, 'note', 'x', '[]', sha256(convert_to('x', 'UTF8')))`, [person]),
    /column "kind" of relation "post" does not exist/);
  await app.end();
  // The view's readers keep their grants after the drop and re-create.
  for (const role of ['board_app', 'board_admin', 'board_dump'] as const) {
    const c = await db.client(role);
    await c.query('SELECT 1 FROM board.visible_post LIMIT 1');
    await c.end();
  }
});

test('0007 drops the compatibility links column of visible_post', async () => {
  const owner = await db.client('board_owner');
  assert.deepEqual(await migrate(owner, db.env, ALL), ['0007_visible_post_cleanup.sql']);
  const cols = (await owner.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'board' AND table_name = 'visible_post'`)).rows.map(r => r.column_name);
  assert.ok(!cols.includes('links') && cols.includes('model'));
  await owner.end();
  for (const role of ['board_app', 'board_admin', 'board_dump'] as const) {
    const c = await db.client(role);
    await c.query('SELECT 1 FROM board.visible_post LIMIT 1');
    await c.end();
  }
});
