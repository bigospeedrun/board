// Race ids come from the site's public data, not its source.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {racesFrom, seededSlugs, migrationSql, nextMigrationName} from '../../scripts/sync-boards.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/chat-knowledge.races.json', import.meta.url), 'utf8'));

test('every public race in the 2026-10-16 snapshot has a seeded board', () => {
  const races = racesFrom(fixture);
  assert.equal(races.length, 19);
  assert.deepEqual(races.filter(r => !seededSlugs().has(r.slug)), []);
  assert.ok(races.some(r => r.slug === 'other-ordered-matrix-removal'));
});

test('a new race produces an additive migration; bad paths are ignored', () => {
  const races = racesFrom({problems: [{path: '/new-race', title: "O'Brien bound"}, {path: '/../x', title: 'bad'}], otherBounds: {rows: [{path: '/other/new-row', title: 'Row'}]}});
  assert.deepEqual(races.map(r => r.slug), ['new-race', 'other-new-row']);
  const sql = migrationSql(races, 'test', 'now');
  assert.match(sql, /\('new-race', 'O''Brien bound'\)/);
  assert.throws(() => racesFrom({}), /no races/);
  const dir = mkdtempSync(join(tmpdir(), 'bos-mig-'));
  writeFileSync(join(dir, '0007_x.sql'), '');
  assert.equal(nextMigrationName(dir + '/'), '0008_boards.sql');
});

test('the slugs api, auth and assets are refused: they are paths of the board host', () => {
  for (const slug of ['api', 'auth', 'assets'])
    assert.throws(() => racesFrom({problems: [{path: '/' + slug, title: 'X'}, {path: '/fine', title: 'Fine'}]}), new RegExp(`reserved board slug: ${slug}`));
  assert.deepEqual(racesFrom({problems: [{path: '/apis', title: 'X'}]}).map(r => r.slug), ['apis']);
  assert.deepEqual(racesFrom({otherBounds: {rows: [{path: '/other/api', title: 'X'}]}}).map(r => r.slug), ['other-api']);
});

test('a ";" or ")" inside a quoted title does not hide later boards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-mig-'));
  writeFileSync(join(dir, '0001_x.sql'), "INSERT INTO board.board (slug, title) VALUES\n  ('a-one', 'Semi; colon (and paren)'),\n  ('b-two', 'It''s; fine'),\n  ('c-three', 'Last');\n");
  assert.deepEqual([...seededSlugs(dir + '/')].sort(), ['a-one', 'b-two', 'c-three']);
});
