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
