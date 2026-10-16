// Launch basics of the board pages (Nil, 2026-10-16): search and link preview tags,
// robots.txt, sitemap.xml, the icons and manifest, and Google Analytics on the board-api
// pages only, with a CSP that allows exactly what GA needs.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request, type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {createApi, type Store} from '../../src/api.ts';
import {configFrom} from '../../src/rules.ts';
import {PAGE_HEADERS, signInPage, accountPage, messagePage} from '../../src/pages.ts';

const store = {
  async sessionByHash() { return null; },
  async boards() { return [{slug: '3sum', title: '3SUM'}, {slug: 'other-catalan', title: 'Catalan’s constant'}, {slug: 'assets', title: 'Reserved'}]; },
} as unknown as Store;
const server: Server = createServer(createApi(store, configFrom({})));
after(() => server.close());
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const get = (path: string, method = 'GET') => new Promise<{status: number; text: string; headers: Record<string, any>; body: Buffer}>((resolve, reject) => {
  const req = request({host: '127.0.0.1', port: (server.address() as any).port, method, path}, res => {
    const chunks: Buffer[] = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => { const body = Buffer.concat(chunks); resolve({status: res.statusCode!, text: body.toString(), headers: res.headers, body}); });
  });
  req.on('error', reject); req.end();
});
const meta = (html: string, attr: 'name' | 'property', key: string) => new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`).exec(html)?.[1];
const GA_CSP = "default-src 'none'; script-src 'self' https://*.googletagmanager.com; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; " +
  "font-src 'self'; img-src 'self' https://*.google-analytics.com https://*.googletagmanager.com; " +
  "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

test('board list and a board: title, description, canonical, Open Graph and Twitter tags, indexable', async () => {
  for (const [path, title, description] of [
    ['/', 'Race boards · Big O Speedrun', /^Race boards for the Big O Speedrun problems\./],
    ['/3sum', '3SUM board · Big O Speedrun', /^What people and their AI agents tried on 3SUM: /],
    ['/other-catalan', 'Catalan’s constant board · Big O Speedrun', /Catalan’s constant/]] as const) {
    const {status, text} = await get(path);
    assert.equal(status, 200, path);
    assert.match(text, new RegExp(`<title>${title}</title>`), path);
    assert.doesNotMatch(text, /noindex/, path);
    assert.match(text, new RegExp(`<link rel="canonical" href="https://board\\.bigospeedrun\\.com${path === '/' ? '/' : path}">`), path);
    assert.match(meta(text, 'name', 'description')!, description, path);
    assert.equal(meta(text, 'property', 'og:title'), title, path);
    assert.equal(meta(text, 'property', 'og:url'), 'https://board.bigospeedrun.com' + path, path);
    assert.equal(meta(text, 'property', 'og:description'), meta(text, 'name', 'description'), path);
    assert.match(meta(text, 'property', 'og:image')!, /^https:\/\/board\.bigospeedrun\.com\/assets\/og\.png\?v=[0-9a-f]{10}$/, path);
    assert.equal(meta(text, 'name', 'twitter:card'), 'summary_large_image', path);
    assert.equal(meta(text, 'name', 'twitter:image'), meta(text, 'property', 'og:image'), path);
    assert.match(text, /<link rel="manifest" href="\/site\.webmanifest">/, path);
    assert.match(text, /<link rel="help" href="\/llms\.txt">/, path);   // the agent guide (src/llms.ts, Worker 3)
    assert.match(text, /<link rel="icon" href="\/favicon\.ico" sizes="any">/, path);
    assert.match(text, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" sizes="180x180">/, path);
    assert.match(text, /<meta name="theme-color" content="#f5f7fb" media="\(prefers-color-scheme: light\)">/, path);
    assert.match(text, /<script src="\/assets\/analytics\.js\?v=[0-9a-f]{10}" defer><\/script>/, path);
  }
});

test('the 404 page loads analytics but is noindex and has no canonical', async () => {
  const {status, text} = await get('/no/such/path');
  assert.equal(status, 404);
  assert.match(text, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(text, /rel="canonical"|og:url/);
  assert.match(text, /analytics\.js/);
});

test('CSP: board-api pages allow exactly Google\'s GA4 list; board-auth pages allow no outside origin', async () => {
  for (const path of ['/', '/3sum', '/nope']) assert.equal((await get(path)).headers['content-security-policy'], GA_CSP, path);
  assert.doesNotMatch(PAGE_HEADERS['Content-Security-Policy'], /https:|google/);
  for (const html of [signInPage(), accountPage('alice', []), messagePage('t', 'm', false)]) {
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(html, /analytics\.js|og:|rel="canonical"/);
  }
});

test('analytics.js: the site\'s GA property and settings, on the board host only', () => {
  const js = readFileSync(new URL('../../public/analytics.js', import.meta.url), 'utf8');
  assert.match(js, /location\.hostname !== "board\.bigospeedrun\.com"/);
  assert.match(js, /MEASUREMENT_ID = "G-MZ689LR3LG"/);
  assert.match(js, /anonymize_ip: true,\s+allow_google_signals: false,\s+allow_ad_personalization_signals: false/);
});

test('robots.txt, sitemap.xml, the manifest and the root icons', async () => {
  const robots = await get('/robots.txt');
  assert.equal(robots.status, 200); assert.match(robots.headers['content-type'], /^text\/plain/);
  assert.equal(robots.text, 'User-agent: *\nAllow: /\nDisallow: /auth/\nDisallow: /api/\n\nSitemap: https://board.bigospeedrun.com/sitemap.xml\n');
  const map = await get('/sitemap.xml');
  assert.equal(map.status, 200); assert.match(map.headers['content-type'], /^application\/xml/);
  assert.deepEqual([...map.text.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]),
    ['https://board.bigospeedrun.com/', 'https://board.bigospeedrun.com/3sum', 'https://board.bigospeedrun.com/other-catalan']); // no reserved slug
  const manifest = await get('/site.webmanifest');
  assert.match(manifest.headers['content-type'], /^application\/manifest\+json/);
  const m = JSON.parse(manifest.text);
  assert.equal(m.start_url, '/');
  for (const icon of m.icons) assert.equal((await get(icon.src)).status, 200, icon.src);
  for (const [path, type] of [['/favicon.ico', 'image/x-icon'], ['/apple-touch-icon.png', 'image/png'], ['/assets/og.png', 'image/png']]) {
    const r = await get(path);
    assert.equal(r.status, 200, path); assert.equal(r.headers['content-type'], type, path); assert.ok(r.body.length > 1000, path);
  }
  assert.equal((await get('/robots.txt', 'HEAD')).text, '');
  assert.equal((await get('/robots.txt', 'POST')).status, 404);
});
