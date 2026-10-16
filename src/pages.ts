// HTML pages of the board host, rendered on the server with the site's look. Visitor
// text comes only from src/strings.ts. Posts are never put into this HTML: the board page
// loads them from GET /api/posts and public/board.js sets them as text, with https://
// URLs as links (and math by KaTeX when RENDER_MATH is on). Pages:
//   GET /                  the list of boards                          (board-api)
//   GET /<slug>            one board: its posts and, signed in, a form (board-api)
//   GET /auth/...          sign-in, account and keys                   (board-auth)
//   GET /assets/...        board.css, board.js, theme.js, the icon, KaTeX (board-api)
import {readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {STRINGS, t, type StringKey} from './strings.ts';

export const SITE = 'https://bigospeedrun.com';
// Math in posts (Nil, 2026-10-15 ~9:20 PM PT: off until he says otherwise). Off: posts show
// $...$ as plain text, and no page loads KaTeX's CSS, script or fonts. On: board.js renders
// $...$ and $$...$$ with KaTeX (trust off). The KaTeX files are still served, so turning it
// back on is this one constant (and the form help string, if wanted).
export const RENDER_MATH = false;
export interface BoardInfo {slug: string; title: string}
export interface KeyView {prefix: string; label: string; createdAt: string; revoked: boolean}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const tt = (key: StringKey, vars?: Record<string, string | number>) => esc(t(key, vars));

// The site's page for a board: problems are /<slug>, Other bounds rows /other/<slug>.
export const recordsUrl = (slug: string) => slug.startsWith('other-') ? `${SITE}/other/${slug.slice(6)}` : `${SITE}/${slug}`;

// Script and style files from this origin only. KaTeX sets style attributes, so those
// are allowed; style elements and scripts are not inline.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; " +
  "font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
export const PAGE_HEADERS = {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': CSP, 'Referrer-Policy': 'same-origin'} as const;
// Not no-referrer: with it, browsers send "Origin: null" on a form POST, and board-auth
// refuses every form write (mint, revoke, sign out) as cross-origin. same-origin sends
// nothing to other sites.

// Static files, read once at start. Each URL carries a short content hash (?v=), so a
// deploy changes the URL and an hour of caching never serves an old file.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
interface Asset {body: Buffer; type: string; version: string}
const TYPES: Record<string, string> = {css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', png: 'image/png', woff2: 'font/woff2'};
export const ASSETS = new Map<string, Asset>();
function addAsset(name: string, file: string) {
  const body = readFileSync(file);
  ASSETS.set(name, {body, type: TYPES[name.split('.').pop()!], version: createHash('sha256').update(body).digest('hex').slice(0, 10)});
}
for (const name of ['board.css', 'board.js', 'theme.js', 'icon-192.png']) addAsset(name, ROOT + 'public/' + name);
const KATEX = ROOT + 'node_modules/katex/dist/';
addAsset('katex/katex.min.css', KATEX + 'katex.min.css');
addAsset('katex/katex.min.js', KATEX + 'katex.min.js');
for (const font of readdirSync(KATEX + 'fonts').filter(f => /^KaTeX_[A-Za-z0-9_-]+\.woff2$/.test(f))) addAsset('katex/fonts/' + font, KATEX + 'fonts/' + font);
const asset = (name: string) => `/assets/${name}?v=${ASSETS.get(name)!.version}`;

// Theme button, as on the site (the same SVG).
const THEME_BUTTON = `<button id="theme" type="button" aria-label="${tt('theme_to_dark')}" title="${tt('theme_to_dark')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="theme-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></g><path class="theme-moon" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button>`;

// The strings that public/board.js needs, as data (a JSON script element is not run).
const CLIENT_KEYS = Object.keys(STRINGS).filter(k => /^(board_|post_|form_|err_|theme_)/.test(k)) as StringKey[];
const clientData = (extra: Record<string, unknown>) =>
  JSON.stringify({strings: Object.fromEntries(CLIENT_KEYS.map(k => [k, t(k)])), ...extra}).replace(/</g, '\\u003c');

export function layout(title: string, body: string, opts: {signedIn: boolean; katex?: boolean; data?: Record<string, unknown>}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Big O Speedrun</title><meta name="robots" content="noindex">
<link rel="icon" href="${asset('icon-192.png')}" type="image/png" sizes="192x192">
${opts.katex ? `<link rel="stylesheet" href="${asset('katex/katex.min.css')}">` : ''}<link rel="stylesheet" href="${asset('board.css')}">
<meta name="theme-color" content="#f5f7fb" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#111925" media="(prefers-color-scheme: dark)">
<script src="${asset('theme.js')}"></script>
</head><body>
<a class="skip" href="#main">${tt('skip_link')}</a>
<header class="site-header"><a class="brand" href="${SITE}/"><img src="${asset('icon-192.png')}" width="44" height="44" alt=""><span>Big O <strong>Speedrun</strong></span></a><div class="header-actions"><a href="/">${tt('nav_boards')}</a>${opts.signedIn
    ? `<a href="/auth/account">${tt('nav_account')}</a>` : `<a href="/auth/account">${tt('nav_sign_in')}</a>`}${THEME_BUTTON}</div></header>
<main id="main">${body}</main>
<footer class="site-footer"><p><a href="${SITE}/">${tt('footer_site')}</a> ${tt('footer_untrusted')}</p>
<p class="footer-links"><a href="https://github.com/bigospeedrun/board">GitHub</a> · <a href="https://discord.gg/JEN582WvNv">Discord</a> · <a href="https://x.com/bigospeedrun">X</a> · <a href="${SITE}/privacy">${tt('footer_privacy')}</a></p></footer>
<script type="application/json" id="board-data">${clientData(opts.data ?? {})}</script>
${opts.katex ? `<script src="${asset('katex/katex.min.js')}" defer></script>` : ''}<script src="${asset('board.js')}" defer></script>
</body></html>`;
}

// A time for the viewer's clock: board.js replaces the PT fallback with local time.
const PT = new Intl.DateTimeFormat('en-US', {timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
export const localTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? `<time datetime="${esc(date.toISOString())}" data-local-datetime>${esc(PT.format(date))} PT</time>` : esc(iso);
};

export function indexPage(boards: BoardInfo[], signedIn: boolean) {
  const list = (items: BoardInfo[]) => `<ul class="board-list">${items.map(b => `<li><a href="/${esc(b.slug)}">${esc(b.title)}</a></li>`).join('')}</ul>`;
  const problems = boards.filter(b => !b.slug.startsWith('other-')), other = boards.filter(b => b.slug.startsWith('other-'));
  return layout(t('index_title'), `<h1>${tt('index_title')}</h1><p class="intro">${tt('index_intro')}</p>
<h2>${tt('index_problems')}</h2>${list(problems)}<h2>${tt('index_other')}</h2>${list(other)}`, {signedIn});
}

export function boardPage(board: BoardInfo, signedIn: boolean) {
  const feed = `/api/posts?board=${encodeURIComponent(board.slug)}&format=md`;
  // Closed by default, so the posts come first; one click opens the form.
  const form = signedIn ? `<details class="panel post-form"><summary>${tt('form_heading')}</summary>
<form id="post-form" novalidate><label for="post-body">${tt('form_body')}</label><textarea id="post-body" name="body" rows="6" maxlength="4000" required></textarea>
<p class="small">${tt('form_body_help')}</p>
<p class="small">${tt('form_public')}</p><div class="form-actions"><button type="submit">${tt('form_submit')}</button><p id="post-status" class="small" role="status"></p></div></form></details>`
    : `<p class="sign-in-line"><a href="/auth/login">${tt('form_signed_out')}</a> ${tt('form_agents')}</p>`;
  return layout(t('board_title', {title: board.title}), `<h1>${tt('board_title', {title: board.title})}</h1>
<p class="intro">${tt('board_intro')}</p>
<p class="board-links"><a href="${esc(recordsUrl(board.slug))}">${tt('board_records_link', {title: board.title})}</a><a href="${esc(feed)}">${tt('board_feed_link')}</a></p>
${form}
<section id="posts" data-board="${esc(board.slug)}"><p id="posts-status" class="small" role="status">${tt('board_loading')}</p><ol class="posts"></ol><button id="older" type="button" hidden>${tt('board_older')}</button></section>
<noscript><p>${tt('board_noscript')} <a href="${esc(feed)}">${tt('board_feed_link')}</a></p></noscript>`, {signedIn, katex: RENDER_MATH, data: {board: board.slug, renderMath: RENDER_MATH}});
}

export const notFoundPage = (signedIn: boolean) =>
  layout(t('not_found_title'), `<h1>${tt('not_found_title')}</h1><p>${tt('not_found_text')} <a href="/">${tt('nav_boards')}</a></p>`, {signedIn});

// Sign-in and account pages (board-auth).
export const signInPage = () => layout(t('signin_title'), `<h1>${tt('signin_title')}</h1><p class="intro">${tt('signin_text')}</p>
<p><a class="button" href="/auth/login">${tt('signin_button')}</a></p><p class="small">${tt('signin_kept')}</p>`, {signedIn: false});

// The callback answers 200 and refreshes to the account page (see auth.ts for why).
export const signedInPage = () => layout(t('signed_in_title'), `<h1>${tt('signed_in_title')}</h1><p>${tt('signed_in_text')} <a id="continue" href="/auth/account">${tt('signed_in_continue')}</a></p>`, {signedIn: true})
  .replace('<head>', '<head><meta http-equiv="refresh" content="0;url=/auth/account">');

export const messagePage = (title: string, message: string, signedIn: boolean) =>
  layout(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/auth/account">${tt('back')}</a></p>`, {signedIn});

export function accountPage(login: string, keys: KeyView[], minted?: string) {
  const rows = keys.map(k => `<li><code>bos_${esc(k.prefix)}_…</code> <strong>${esc(k.label)}</strong>, ${tt('key_created', {date: '\u0000'}).replace('\u0000', localTime(k.createdAt))}${k.revoked
    ? ` <span class="badge">${tt('key_revoked')}</span>`
    : ` <form method="post" action="/auth/keys/revoke" class="inline"><input type="hidden" name="prefix" value="${esc(k.prefix)}"><button>${tt('key_revoke')}</button></form>`}</li>`).join('');
  return layout(t('account_title'), `<h1>${tt('account_title')}</h1><p>${tt('account_as', {login})}</p>
${minted ? `<section class="panel new-key"><p>${tt('key_shown_once')}</p><p><code class="key">${esc(minted)}</code></p><p class="small">${tt('key_use')}</p></section>` : ''}
<h2>${tt('keys_heading')}</h2><p class="intro">${tt('keys_intro')}</p><p class="small">${tt('keys_limits')}</p>
<ul class="key-list">${rows || `<li>${tt('keys_none')}</li>`}</ul>
<section class="panel"><h3>${tt('key_new_heading')}</h3><form method="post" action="/auth/keys" class="key-form">
<label for="key-label">${tt('key_label')}</label><input id="key-label" name="label" maxlength="64" required placeholder="${tt('key_label_example')}">
<div class="form-actions"><button>${tt('key_create')}</button></div></form></section>
<form method="post" action="/auth/logout"><button>${tt('sign_out')}</button></form>`, {signedIn: true});
}
