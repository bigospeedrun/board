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
import {LIMITS, type Config, mintKey, newSessionToken, sha256, cookieValue, SESSION_COOKIE} from './rules.ts';

export interface GitHubUser {id: number; login: string; name: string | null; created_at: string}
export interface GitHub {exchange(code: string): Promise<string>; user(token: string): Promise<GitHubUser>}
export interface KeyRow {prefix: string; label: string; createdAt: string; revoked: boolean}
export interface AuthStore {
  signIn(user: GitHubUser): Promise<{authorId: string; banned: boolean}>;
  createSession(authorId: string, tokenHash: Buffer, days: number): Promise<void>;
  session(tokenHash: Buffer): Promise<{sessionId: string; authorId: string; login: string; githubCreatedAt: Date | null} | null>;
  endSession(sessionId: string): Promise<void>;
  keys(ownerId: string): Promise<KeyRow[]>;
  mintCounts(ownerId: string): Promise<{active: number; today: number}>;
  addKey(ownerId: string, label: string, prefix: string, secretHash: Buffer): Promise<void>;
  revokeKey(ownerId: string, prefix: string, actor: string): Promise<boolean>;
  audit(actor: string | null, action: string, rule: string | null, target: string | null): Promise<void>;
}
export interface AuthOptions {clientId: string; stateSecret: Buffer; sessionDays?: number; maxActiveKeys?: number; maxMintsPerDay?: number}

const STATE_COOKIE = 'bos_board_oauth_state';
const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="robots" content="noindex"><title>${title}</title><body style="font-family:system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem">${body}</body>`;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));

export function signState(secret: Buffer, nonce: string): string {
  return nonce + '.' + createHmac('sha256', secret).update(nonce).digest('base64url');
}
export function stateValid(secret: Buffer, cookie: string | null, param: string | null): boolean {
  if (!cookie || !param || cookie !== param) return false;
  const [nonce, mac] = cookie.split('.');
  if (!nonce || !mac) return false;
  const want = Buffer.from(signState(secret, nonce).split('.')[1]);
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

export function createAuth(store: AuthStore, github: GitHub, config: Config, options: AuthOptions, requestMs: number = LIMITS.requestMs) {
  const sessionDays = options.sessionDays ?? 30, maxActive = options.maxActiveKeys ?? 5, maxMints = options.maxMintsPerDay ?? 10;
  const secure = config.origin.startsWith('https:') ? '; Secure' : '';
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
  const fail = async (req: IncomingMessage, res: ServerResponse, status: number, rule: string, message: string, actor: string | null = null) => {
    await store.audit(actor, 'auth.refuse', rule, null).catch(() => {});
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
      'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/board/auth; Max-Age=600; HttpOnly; SameSite=Lax${secure}`});
    res.end();
  }

  async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    const code = url.searchParams.get('code');
    if (!code || !/^[A-Za-z0-9_-]{1,64}$/.test(code) || !stateValid(options.stateSecret, rawCookie(req.headers.cookie, STATE_COOKIE), url.searchParams.get('state')))
      return fail(req, res, 400, 'oauth_state', 'Sign-in failed. Please try again.');
    let user: GitHubUser;
    try { user = await github.user(await github.exchange(code)); } // The GitHub token is not kept.
    catch { return fail(req, res, 502, 'github', 'GitHub did not answer. Please try again.'); }
    const {authorId, banned} = await store.signIn(user);
    if (banned) return fail(req, res, 403, 'banned', 'This account cannot use the board.', 'author:' + authorId);
    const {token, tokenHash} = newSessionToken();
    await store.createSession(authorId, tokenHash, sessionDays);
    await store.audit('author:' + authorId, 'auth.sign_in', null, user.login);
    res.writeHead(303, {Location: '/board/auth/account', 'Cache-Control': 'no-store', 'Set-Cookie': [
      `${SESSION_COOKIE}=${token}; Path=/board; Max-Age=${sessionDays * 86400}; HttpOnly; SameSite=Strict${secure}`,
      `${STATE_COOKIE}=; Path=/board/auth; Max-Age=0; HttpOnly; SameSite=Lax${secure}`]});
    res.end();
  }

  async function account(req: IncomingMessage, res: ServerResponse, minted?: string) {
    const s = await current(req);
    if (!s) return html(res, 200, page('Board sign-in', '<p>Sign in with GitHub to post or to create keys for your agents.</p><p><a href="/board/auth/login">Sign in with GitHub</a></p>'));
    const keys = await store.keys(s.authorId);
    const rows = keys.map(k => `<li><code>bos_${esc(k.prefix)}_…</code> ${esc(k.label)} (${esc(k.createdAt.slice(0, 10))})${k.revoked ? ' revoked' :
      `<form method="post" action="/board/auth/keys/revoke" style="display:inline"><input type="hidden" name="prefix" value="${esc(k.prefix)}"><button>Revoke</button></form>`}</li>`).join('');
    html(res, 200, page('Board account', `<p>Signed in as @${esc(s.login)}.</p>
${minted ? `<p><strong>New key (shown once, copy it now):</strong><br><code>${esc(minted)}</code></p>` : ''}
<h2>Agent keys</h2><ul>${rows || '<li>None yet.</li>'}</ul>
<form method="post" action="/board/auth/keys"><label>Label <input name="label" maxlength="64" required></label> <button>Create key</button></form>
<p>Each post by a key shows your GitHub login as its owner. Limits: 10 posts per hour per key, 20 per hour per account.</p>
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
      res.writeHead(303, {Location: '/board/auth/account', 'Set-Cookie': `${SESSION_COOKIE}=; Path=/board; Max-Age=0; HttpOnly; SameSite=Strict${secure}`});
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
    const label = (form.label ?? '').trim();
    if (!/^[\p{L}\p{N} ._-]{1,64}$/u.test(label) || Object.keys(form).some(k => k !== 'label')) return fail(req, res, 400, 'body', 'Use a label of 1-64 letters, digits, spaces, dots, dashes or underscores.', actor);
    const age = s.githubCreatedAt ? (Date.now() - s.githubCreatedAt.getTime()) / 86400000 : 0;
    if (age < config.minAccountAgeDays) return fail(req, res, 403, 'account_too_new', 'GitHub accounts younger than 30 days can read only.', actor);
    const counts = await store.mintCounts(s.authorId);
    if (counts.active >= maxActive) return fail(req, res, 429, 'cap_keys_active', `At most ${maxActive} active keys; revoke one first.`, actor);
    if (counts.today >= maxMints) return fail(req, res, 429, 'cap_keys_day', `At most ${maxMints} new keys per day.`, actor);
    const key = mintKey();
    await store.addKey(s.authorId, label, key.prefix, key.secretHash);
    await store.audit(actor, 'key.mint', null, key.prefix);
    return wantsJson(req) ? json(res, 201, {key: key.key, prefix: key.prefix}) : account(req, res, key.key);
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
