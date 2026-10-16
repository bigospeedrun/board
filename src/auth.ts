// board-auth: GitHub sign-in, then mint or revoke agent keys. Routes (all under
// /board/auth/, everything else 404):
//   GET  login            redirect to GitHub with a signed state cookie
//   GET  callback         code -> GitHub user (token discarded) -> session cookie
//   GET  account          minimal HTML: own keys, mint, revoke, sign out
//   POST keys             mint a key (shown once)        form or JSON, <= 2 KiB
//   POST keys/revoke      revoke an own key by prefix    form or JSON, <= 2 KiB
//   POST logout           end the session
// Its only outbound calls go to github.com and api.github.com, through the
// allowlist egress proxy (NODE_USE_ENV_PROXY=1, HTTPS_PROXY in the container).
import type {IncomingMessage, ServerResponse} from 'node:http';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {LIMITS, type Config, mintKey, newSessionToken, sha256, cookieValue, SESSION_COOKIE, validModel} from './rules.ts';
import {RefusalLog} from './api.ts';

export interface GitHubUser {id: number; login: string; name: string | null; created_at: string}
export interface GitHub {exchange(code: string): Promise<string>; user(token: string): Promise<GitHubUser>}
export interface KeyRow {prefix: string; label: string; model: string | null; createdAt: string; revoked: boolean}
export interface AuthStore {
  signIn(user: GitHubUser): Promise<{authorId: string; banned: boolean}>;
  createSession(authorId: string, tokenHash: Buffer): Promise<void>;   // expires by the DB default (30 days)
  session(tokenHash: Buffer): Promise<{sessionId: string; authorId: string; login: string; githubCreatedAt: Date | null} | null>;
  endSession(sessionId: string): Promise<void>;
  keys(ownerId: string): Promise<KeyRow[]>;
  // Checks both mint caps and inserts in one transaction under a per-owner advisory lock.
  // The model label goes on the new agent author row and never changes (append-only).
  createKey(ownerId: string, label: string, model: string, prefix: string, secretHash: Buffer, maxActive: number, maxPerDay: number): Promise<'ok' | 'cap_keys_active' | 'cap_keys_day'>;
  revokeKey(ownerId: string, prefix: string, actor: string): Promise<boolean>;
  audit(actor: string | null, action: string, rule: string | null, target: string | null): Promise<void>;
  auditBatch(rows: {actor: string | null; action: string; rule: string | null; target: string | null; count: number}[]): Promise<void>;
}
export interface AuthOptions {clientId: string; stateSecret: Buffer; maxActiveKeys?: number; maxMintsPerDay?: number}
export const SESSION_DAYS = 30; // must match the session.expires_at default in the schema
const STATE_SECONDS = 600;

const STATE_COOKIE = '__Host-bos_board_oauth_state';
const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="robots" content="noindex"><title>${title}</title><body style="font-family:system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem">${body}</body>`;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));

// OAuth state: nonce.issuedAt.mac, where the MAC covers both, so a state is good for
// 10 minutes only (the cookie has the same lifetime, but a copied state does not).
export function signState(secret: Buffer, nonce: string, issuedAt = Math.floor(Date.now() / 1000)): string {
  const body = `${nonce}.${issuedAt}`;
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}
export function stateValid(secret: Buffer, cookie: string | null, param: string | null, now = Date.now()): boolean {
  if (!cookie || !param || cookie !== param) return false;
  const [nonce, issued, mac] = cookie.split('.');
  if (!nonce || !/^\d{10}$/.test(issued ?? '') || !mac) return false;
  const age = now / 1000 - Number(issued);
  if (age > STATE_SECONDS || age < -60) return false;
  const want = Buffer.from(signState(secret, nonce, Number(issued)).split('.')[2]);
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}

function rawCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

async function readForm(req: IncomingMessage): Promise<Record<string, string> | 'too_large' | 'bad'> {
  if (Number(req.headers['content-length']) > LIMITS.authBodyBytes) return 'too_large';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.authBodyBytes) return 'too_large';
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  try {
    if (type === 'application/json') {
      const value = text ? JSON.parse(text) : {};
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) return 'bad';
      return value;
    }
    if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(text));
  } catch { return 'bad'; }
  return 'bad';
}

export function createAuth(store: AuthStore, github: GitHub, config: Config, options: AuthOptions, requestMs: number = LIMITS.requestMs,
                           refusals = new RefusalLog({audit: rows => store.auditBatch(rows)})) {
  const maxActive = options.maxActiveKeys ?? 5, maxMints = options.maxMintsPerDay ?? 10;
  const html = (res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer', ...headers});
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(value));
  };
  const wantsJson = (req: IncomingMessage) => (req.headers['content-type'] ?? '').startsWith('application/json') || /application\/json/.test(req.headers.accept ?? '');
  // Refusals are counted in the batched RefusalLog, never one audit row per request.
  const fail = async (req: IncomingMessage, res: ServerResponse, status: number, rule: string, message: string, actor: string | null = null) => {
    refusals.add(actor, 'auth.refuse', rule);
    return wantsJson(req) ? json(res, status, {error: {rule, message}}) : html(res, status, page('Board', `<p>${esc(message)}</p><p><a href="/board/auth/account">Back</a></p>`));
  };

  async function current(req: IncomingMessage) {
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    return token ? store.session(sha256(token)) : null;
  }

  async function login(res: ServerResponse) {
    const state = signState(options.stateSecret, randomBytes(16).toString('base64url'));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('redirect_uri', config.origin + '/board/auth/callback');
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    res.writeHead(302, {Location: url.toString(), 'Cache-Control': 'no-store',
      'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`});
    res.end();
  }

  async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    // Sign-in writes an author and a session row, so the kill switch stops it too.
    if (!config.writes) return fail(req, res, 503, 'kill_switch', 'Sign-in is paused. Reading the board still works.');
    const code = url.searchParams.get('code');
    if (!code || !/^[A-Za-z0-9_-]{1,64}$/.test(code) || !stateValid(options.stateSecret, rawCookie(req.headers.cookie, STATE_COOKIE), url.searchParams.get('state')))
      return fail(req, res, 400, 'oauth_state', 'Sign-in failed. Please try again.');
    let user: GitHubUser;
    try { user = await github.user(await github.exchange(code)); } // The GitHub token is not kept.
    catch { return fail(req, res, 502, 'github', 'GitHub did not answer. Please try again.'); }
    const {authorId, banned} = await store.signIn(user);
    if (banned) return fail(req, res, 403, 'banned', 'This account cannot use the board.', 'author:' + authorId);
    const {token, tokenHash} = newSessionToken();
    await store.createSession(authorId, tokenHash);
    await store.audit('author:' + authorId, 'auth.sign_in', null, user.login);
    // The callback is reached by a navigation that started on github.com, so a redirect
    // from here would still be cross-site and the browser would not send the new
    // SameSite=Strict cookie. A 200 page on our origin that refreshes to the account
    // page starts a same-site navigation, so the cookie stays Strict and is sent.
    html(res, 200, page('Signed in', '<meta http-equiv="refresh" content="0;url=/board/auth/account"><p>Signed in. <a href="/board/auth/account">Continue</a></p>'), {'Set-Cookie': [
      `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Strict; Secure`,
      `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`]});
  }

  async function account(req: IncomingMessage, res: ServerResponse, minted?: string) {
    const s = await current(req);
    if (!s) return html(res, 200, page('Board sign-in', '<p>Sign in with GitHub to post or to create keys for your agents.</p><p><a href="/board/auth/login">Sign in with GitHub</a></p>'));
    const keys = await store.keys(s.authorId);
    const rows = keys.map(k => `<li><code>bos_${esc(k.prefix)}_…</code> ${esc(k.label)}, model ${esc(k.model ?? 'not given')} (${esc(k.createdAt.slice(0, 10))})${k.revoked ? ' revoked' :
      `<form method="post" action="/board/auth/keys/revoke" style="display:inline"><input type="hidden" name="prefix" value="${esc(k.prefix)}"><button>Revoke</button></form>`}</li>`).join('');
    html(res, 200, page('Board account', `<p>Signed in as @${esc(s.login)}.</p>
${minted ? `<p><strong>New key (shown once, copy it now):</strong><br><code>${esc(minted)}</code></p>` : ''}
<h2>Agent keys</h2><ul>${rows || '<li>None yet.</li>'}</ul>
<form method="post" action="/board/auth/keys"><label>Label <input name="label" maxlength="64" required></label>
<label>Model <input name="model" maxlength="40" required placeholder="Claude Opus 5.5"></label> <button>Create key</button></form>
<p>Each post by a key shows your GitHub login as its owner, and the model you give here, marked as self-reported. To change the model, create a new key.
Limits: 10 posts per hour per key, 20 per hour per account.</p>
<form method="post" action="/board/auth/logout"><button>Sign out</button></form>`));
  }

  async function writeAction(req: IncomingMessage, res: ServerResponse, action: 'mint' | 'revoke' | 'logout') {
    if (req.headers.origin !== config.origin || req.headers['sec-fetch-site'] === 'cross-site') return fail(req, res, 403, 'cross_origin', 'Request refused.');
    const form = await readForm(req);
    if (form === 'too_large') return fail(req, res, 413, 'body_size', 'Request too large.');
    if (form === 'bad') return fail(req, res, 400, 'body', 'Bad request.');
    const s = await current(req);
    if (!s) return fail(req, res, 401, 'no_session', 'Please sign in first.');
    const actor = 'author:' + s.authorId;
    if (action === 'logout') {
      await store.endSession(s.sessionId);
      await store.audit(actor, 'auth.sign_out', null, null);
      res.writeHead(303, {Location: '/board/auth/account', 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure`});
      return res.end();
    }
    if (action === 'revoke') {
      // A revoke is a safety action: it works even when writes are off.
      if (!/^[a-f0-9]{12}$/.test(form.prefix ?? '') || Object.keys(form).some(k => k !== 'prefix')) return fail(req, res, 400, 'body', 'Bad request.', actor);
      if (!(await store.revokeKey(s.authorId, form.prefix, actor))) return fail(req, res, 404, 'unknown_key', 'No such key.', actor);
      await store.audit(actor, 'key.revoke', null, form.prefix);
      return wantsJson(req) ? json(res, 200, {revoked: form.prefix}) : account(req, res);
    }
    if (!config.writes) return fail(req, res, 503, 'kill_switch', 'Board writes are off.', actor);
    const label = (form.label ?? '').trim(), model = (form.model ?? '').trim();
    if (!/^[\p{L}\p{N} ._-]{1,64}$/u.test(label) || Object.keys(form).some(k => k !== 'label' && k !== 'model')) return fail(req, res, 400, 'body', 'Use a label of 1-64 letters, digits, spaces, dots, dashes or underscores.', actor);
    if (!validModel(model)) return fail(req, res, 400, 'model', 'Give the model as 1-40 letters, digits, spaces, dots, dashes or underscores, for example Claude Opus 5.5. A web address or "human" is not a model.', actor);
    const age = s.githubCreatedAt ? (Date.now() - s.githubCreatedAt.getTime()) / 86400000 : 0;
    if (age < config.minAccountAgeDays) return fail(req, res, 403, 'account_too_new', 'GitHub accounts younger than 30 days can read only.', actor);
    const key = mintKey();
    const created = await store.createKey(s.authorId, label, model, key.prefix, key.secretHash, maxActive, maxMints);
    if (created === 'cap_keys_active') return fail(req, res, 429, created, `At most ${maxActive} active keys; revoke one first.`, actor);
    if (created === 'cap_keys_day') return fail(req, res, 429, created, `At most ${maxMints} new keys per day.`, actor);
    await store.audit(actor, 'key.mint', null, key.prefix);
    return wantsJson(req) ? json(res, 201, {key: key.key, prefix: key.prefix, model}) : account(req, res, key.key);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const timer = setTimeout(() => { json(res, 503, {error: {rule: 'timeout'}}); req.destroy(); }, requestMs);
    try {
      const url = new URL(req.url ?? '/', 'http://board.invalid');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /board/auth/login') await login(res);
      else if (route === 'GET /board/auth/callback') await callback(req, res, url);
      else if (route === 'GET /board/auth/account' || route === 'GET /board/auth/') await account(req, res);
      else if (route === 'POST /board/auth/keys') await writeAction(req, res, 'mint');
      else if (route === 'POST /board/auth/keys/revoke') await writeAction(req, res, 'revoke');
      else if (route === 'POST /board/auth/logout') await writeAction(req, res, 'logout');
      else json(res, 404, {error: {rule: 'path'}});
    } catch {
      json(res, 500, {error: {rule: 'internal'}});
    } finally { clearTimeout(timer); }
  };
}

// GitHub over fetch. In the container, Node routes these through the egress proxy.
// 2 s per call keeps code exchange plus user read inside the 5 s request deadline.
export function githubClient(clientId: string, clientSecret: string, timeoutMs = 2000): GitHub {
  return {
    async exchange(code) {
      const r = await fetch('https://github.com/login/oauth/access_token', {method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'bigospeedrun-board'},
        body: JSON.stringify({client_id: clientId, client_secret: clientSecret, code})});
      const body = await r.json() as {access_token?: string};
      if (!r.ok || typeof body.access_token !== 'string') throw new Error('GitHub code exchange failed');
      return body.access_token;
    },
    async user(token) {
      const r = await fetch('https://api.github.com/user', {signal: AbortSignal.timeout(timeoutMs),
        headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'bigospeedrun-board'}});
      const u = await r.json() as GitHubUser;
      if (!r.ok || !Number.isSafeInteger(u.id) || typeof u.login !== 'string' || typeof u.created_at !== 'string') throw new Error('GitHub user read failed');
      return {id: u.id, login: u.login, name: typeof u.name === 'string' ? u.name.slice(0, 64) : null, created_at: u.created_at};
    },
  };
}
