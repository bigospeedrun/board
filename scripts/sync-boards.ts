// Read the race list from the site's PUBLIC data (chat-knowledge.json, published at
// https://bigospeedrun.com/chat-knowledge.json) and write a new migration for races that
// have no board yet, or for a change of order. Boards are never removed or renamed:
// migrations are forward-only. Run by a person; the board services never fetch anything.
// Order: the board list at / follows the site (BOS Lead Dev for Nil, 2026-10-16). The
// public data lists the problems in the site's Problems menu order and the Other bounds
// rows in the site's order, and racesFrom keeps that order (problems, then Other bounds).
// Each migration from this script states the whole order (board.board.position, 0009) and
// every title, so a new race lands in its place, and a renamed race gets its new title, on
// the next sync with no other step. Titles: a problem's `name` (the site's landing table and
// Problems menu name; site 3ab4b26 publishes it), else its `title`; an Other bounds row's
// `title` (the site's row name).
//   node --experimental-strip-types scripts/sync-boards.ts [url-or-file] [--write]
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {RESERVED_SLUGS} from '../src/rules.ts';

export const PUBLIC_URL = 'https://bigospeedrun.com/chat-knowledge.json';
const MIGRATIONS = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export interface Race {slug: string; title: string}

// Problem pages are /<slug>; Other bounds rows are /other/<slug> -> board other-<slug>.
// The result is in the site's order.
export function racesFrom(knowledge: any): Race[] {
  const races: Race[] = [];
  for (const p of knowledge?.problems ?? []) {
    const m = /^\/([a-z0-9][a-z0-9-]{0,62})$/.exec(p.path ?? '');
    const title = typeof p.name === 'string' ? p.name : p.title;
    if (m && typeof title === 'string') races.push({slug: m[1], title});
  }
  for (const r of knowledge?.otherBounds?.rows ?? []) {
    const m = /^\/other\/([a-z0-9][a-z0-9-]{0,56})$/.exec(r.path ?? '');
    if (m && typeof r.title === 'string') races.push({slug: 'other-' + m[1], title: r.title});
  }
  if (!races.length) throw new Error('no races found in the public data');
  const reserved = races.filter(r => RESERVED_SLUGS.includes(r.slug));
  if (reserved.length) throw new Error(`reserved board slug: ${reserved.map(r => r.slug).join(', ')} (a path of the board host)`);
  return races;
}

// Slugs already seeded by INSERT INTO board.board statements in the migrations.
export function seededSlugs(dir = MIGRATIONS): Set<string> {
  const slugs = new Set<string>();
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql'))) {
    const sql = readFileSync(dir + file, 'utf8');
    // Each ('slug', 'title') tuple after INSERT INTO board.board, up to the statement's
    // end. Titles are quoted SQL strings ('' is a quote), so a ';' or ')' inside a title
    // cannot end the scan early.
    for (const start of sql.matchAll(/INSERT INTO board\.board\b[^(]*\([^)]*\)\s*VALUES/gi)) {
      const tuple = /\s*,?\s*\(\s*'([a-z0-9-]+)'\s*,\s*'(?:[^']|'')*'\s*\)/y;
      tuple.lastIndex = start.index! + start[0].length;
      for (let m; (m = tuple.exec(sql));) slugs.add(m[1]);
    }
  }
  return slugs;
}

// The order statement. Every migration from this script ends with one, and statedBoards
// reads the last one back, so keep orderSql and ORDER_STATEMENT in step. 0009 has the first
// form, with no titles; later ones also set every title.
const ORDER_STATEMENT = /UPDATE board\.board b SET position = o\.position(?:, title = o\.title)? FROM \(VALUES([\s\S]*?)\n\) AS o\(slug, position(?:, title)?\) WHERE b\.slug = o\.slug;/g;
const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const cleanTitle = (title: string) => title.replace(/[\r\n]+/g, ' ').slice(0, 120);
export function orderSql(races: Race[]): string {
  // A board that the site no longer lists keeps no position: it goes after the others.
  return `-- Board order and titles: the site's (scripts/sync-boards.ts).\nUPDATE board.board SET position = NULL;\n` +
    `UPDATE board.board b SET position = o.position, title = o.title FROM (VALUES\n` +
    races.map((r, i) => `  ('${r.slug}', ${i + 1}, ${quote(cleanTitle(r.title))})`).join(',\n') + `\n) AS o(slug, position, title) WHERE b.slug = o.slug;\n`;
}

// The boards, in order, that the migrations state last (by file name); title is null for a
// statement without titles (0009). [] if none states an order.
export function statedBoards(dir = MIGRATIONS): {slug: string; title: string | null}[] {
  let last: {slug: string; title: string | null; n: number}[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort())
    for (const m of readFileSync(dir + file, 'utf8').matchAll(ORDER_STATEMENT))
      last = [...m[1].matchAll(/\(\s*'([a-z0-9-]+)',\s*(\d+)(?:,\s*'((?:[^']|'')*)')?\s*\)/g)]
        .map(t => ({slug: t[1], n: Number(t[2]), title: t[3] === undefined ? null : t[3].replace(/''/g, "'")}));
  return last.sort((a, b) => a.n - b.n).map(({slug, title}) => ({slug, title}));
}
export const statedOrder = (dir = MIGRATIONS) => statedBoards(dir).map(b => b.slug);

// INSERTs for the new races (if any), then the whole order and every title of `order`.
export function migrationSql(races: Race[], order: Race[], source: string, at: string): string {
  const head = `-- ${races.length ? 'Boards for races new in' : 'A new board order or new titles from'} the site's public data (${source}, updatedAt ${at}).\n` +
    `-- Generated by scripts/sync-boards.ts.\n`;
  const inserts = races.length ? `INSERT INTO board.board (slug, title) VALUES\n` +
    races.map(r => `  (${quote(r.slug)}, ${quote(cleanTitle(r.title))})`).join(',\n') + ';\n' : '';
  return head + inserts + orderSql(order);
}

// What the next sync writes: null when every race has a board and the order and the titles
// are the same as stated.
export function plan(races: Race[], seeded: Set<string>, stated: {slug: string; title: string | null}[]): {missing: Race[]; order: Race[]} | null {
  const missing = races.filter(r => !seeded.has(r.slug));
  const same = races.length === stated.length && races.every((r, i) => r.slug === stated[i].slug && cleanTitle(r.title) === stated[i].title);
  return missing.length || !same ? {missing, order: races} : null;
}

export function nextMigrationName(dir = MIGRATIONS, label = 'boards'): string {
  const last = readdirSync(dir).filter(f => /^\d{4}_/.test(f)).sort().at(-1);
  return String(Number(last?.slice(0, 4) ?? 0) + 1).padStart(4, '0') + '_' + label + '.sql';
}

if (import.meta.main) {
  const source = process.argv.slice(2).find(a => !a.startsWith('--')) ?? PUBLIC_URL;
  const knowledge = /^https:\/\//.test(source) ? await (await fetch(source, {signal: AbortSignal.timeout(15000)})).json() : JSON.parse(readFileSync(source, 'utf8'));
  const next = plan(racesFrom(knowledge), seededSlugs(), statedBoards());
  if (!next) { console.log('All public races have a board, in the site order, with the site titles.'); process.exit(0); }
  const name = nextMigrationName(undefined, next.missing.length ? 'boards' : 'board_order');
  const sql = migrationSql(next.missing, next.order, source.startsWith('https://') ? source : 'local file', knowledge.updatedAt ?? 'unknown');
  if (process.argv.includes('--write')) { writeFileSync(MIGRATIONS + name, sql); console.log('Wrote', name); }
  else console.log(`Would write ${name}:\n${sql}`);
}
