// Race ids come from the site's public data, not its source.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {racesFrom, seededSlugs, migrationSql, nextMigrationName, statedOrder, statedBoards, orderSql, plan} from '../../scripts/sync-boards.ts';
import {indexPage} from '../../src/pages.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/chat-knowledge.races.json', import.meta.url), 'utf8'));

test('every public race in the 2026-10-16 snapshot has a seeded board', () => {
  // The fixture is the site's chat-knowledge.json at a66107b (problems in the menu order).
  const races = racesFrom(fixture);
  assert.equal(races.length, 19);
  assert.deepEqual(races.filter(r => !seededSlugs().has(r.slug)), []);
  assert.ok(races.some(r => r.slug === 'other-ordered-matrix-removal'));
});

test('a new race produces an additive migration; bad paths are ignored', () => {
  const races = racesFrom({problems: [{path: '/new-race', title: "O'Brien bound"}, {path: '/../x', title: 'bad'}], otherBounds: {rows: [{path: '/other/new-row', title: 'Row'}]}});
  assert.deepEqual(races.map(r => r.slug), ['new-race', 'other-new-row']);
  const sql = migrationSql(races, races, 'test', 'now');
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

test('board order: the migrations state the site order, so a sync of the same data writes nothing', () => {
  const races = racesFrom(fixture);
  assert.deepEqual(statedOrder(), races.map(r => r.slug));
  assert.deepEqual(statedOrder().slice(0, 6), ['integer-multiplication', 'matrix-multiplication', 'exact-dft', '3sum', 'apsp', 'subset-sum']);
  assert.equal(plan(races, seededSlugs(), statedBoards()), null);
});

test('board titles: the site names (a problem by its landing table name), stated in the migrations', () => {
  const races = racesFrom(fixture);
  assert.deepEqual(races.slice(0, 6).map(r => r.title), ['Integer Multiplication', 'Matrix Multiplication', 'Fourier Transform', '3SUM', 'APSP', 'Subset Sum']);
  assert.deepEqual(statedBoards().map(b => b.title), races.map(r => r.title));
  // Without name (an older site), the problem title is used.
  assert.equal(racesFrom({problems: [{path: '/x', title: 'Long title'}]})[0].title, 'Long title');
  // A renamed race is a new migration with the new title; a quote in a title survives.
  const dir = mkdtempSync(join(tmpdir(), 'bos-mig-')) + '/';
  writeFileSync(dir + '0003_boards.sql', "INSERT INTO board.board (slug, title) VALUES\n  ('a', 'A'),\n  ('b', 'B');\n");
  writeFileSync(dir + '0009_board_order.sql', orderSql([{slug: 'a', title: 'A'}, {slug: 'b', title: 'B'}]));
  assert.equal(plan([{slug: 'a', title: 'A'}, {slug: 'b', title: 'B'}], seededSlugs(dir), statedBoards(dir)), null);
  const renamed = [{slug: 'a', title: "Al's (new) name; really"}, {slug: 'b', title: 'B'}];
  const step = plan(renamed, seededSlugs(dir), statedBoards(dir))!;
  assert.deepEqual(step.missing, []);
  writeFileSync(dir + '0010_board_order.sql', migrationSql(step.missing, step.order, 'test', 'now'));
  assert.deepEqual(statedBoards(dir), renamed);
  assert.equal(plan(renamed, seededSlugs(dir), statedBoards(dir)), null);
  // A statement in the 0009 form (no titles) reads as titles unknown, so the next sync states them.
  writeFileSync(dir + '0011_old.sql', "UPDATE board.board b SET position = o.position FROM (VALUES\n  ('a', 1),\n  ('b', 2)\n) AS o(slug, position) WHERE b.slug = o.slug;\n");
  assert.deepEqual(statedBoards(dir), [{slug: 'a', title: null}, {slug: 'b', title: null}]);
  assert.ok(plan(renamed, seededSlugs(dir), statedBoards(dir)));
});

test('board order: a new race lands in its place, and a new order alone gets its own migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-mig-')) + '/';
  const base = racesFrom(fixture);
  writeFileSync(dir + '0003_boards.sql', "INSERT INTO board.board (slug, title) VALUES\n" + base.map(r => `  ('${r.slug}', 'x')`).join(',\n') + ';\n');
  writeFileSync(dir + '0009_board_order.sql', orderSql(base));
  assert.equal(plan(base, seededSlugs(dir), statedBoards(dir)), null);
  // A new problem third in the site's menu, and a new Other bounds row at the end.
  const next = [...base.slice(0, 2), {slug: 'new-problem', title: 'New problem'}, ...base.slice(2), {slug: 'other-new-row', title: 'New row'}];
  const step = plan(next, seededSlugs(dir), statedBoards(dir))!;
  assert.deepEqual(step.missing.map(r => r.slug), ['new-problem', 'other-new-row']);
  const sql = migrationSql(step.missing, step.order, 'test', 'now');
  assert.ok(sql.indexOf('INSERT INTO board.board') < sql.indexOf('SET position = o.position'));   // insert first, then order
  writeFileSync(dir + nextMigrationName(dir), sql);
  assert.deepEqual(statedOrder(dir).slice(0, 4), ['integer-multiplication', 'matrix-multiplication', 'new-problem', 'exact-dft']);
  assert.equal(statedOrder(dir).at(-1), 'other-new-row');
  assert.equal(plan(next, seededSlugs(dir), statedBoards(dir)), null);
  // The site moves a race: no new board, only a new order.
  const moved = [next[3], ...next.slice(0, 3), ...next.slice(4)];
  const reorder = plan(moved, seededSlugs(dir), statedBoards(dir))!;
  assert.deepEqual(reorder.missing, []);
  const only = migrationSql(reorder.missing, reorder.order, 'test', 'now');
  assert.doesNotMatch(only, /INSERT/);
  assert.equal(nextMigrationName(dir, 'board_order'), '0011_board_order.sql');
  writeFileSync(dir + '0011_board_order.sql', only);
  assert.deepEqual(statedOrder(dir), moved.map(r => r.slug));
});

test('the board list keeps the order it gets: problems, then Other bounds', () => {
  const html = indexPage(racesFrom(fixture), false);
  const slugs = [...html.matchAll(/<li><a href="\/([a-z0-9-]+)">/g)].map(m => m[1]);
  assert.deepEqual(slugs, racesFrom(fixture).map(r => r.slug));
});
