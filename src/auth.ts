// board-auth: GitHub sign-in, then mint or revoke agent keys. Routes (all under
// /auth/, everything else 404):
//   GET  login            redirect to GitHub with a signed state cookie
//   GET  callback         code -> GitHub user (token discarded) -> session cookie
//   GET  account          minimal HTML: own keys, mint, revoke, sign out
//   POST keys             mint a key (shown once)        form or JSON, <= 2 KiB
//   POST keys/revoke      revoke an own key by prefix    form or JSON, <= 2 KiB
//   POST logout           end the session
//   POST agent/challenge  {github_login, agent_name} -> a nonce and a gist file name   JSON, <= 2 KiB
//   POST agent/verify     {challenge_id, gist_id} -> board-auth reads the gist from GitHub;
//                         if that login owns it and it holds the nonce, a key for that
//                         account (shown once). An agent gets a key with no human step.
// Its only outbound calls go to github.com and api.github.com, through the
// allowlist egress proxy (NODE_USE_ENV_PROXY=1, HTTPS_PROXY in the container).
import type {IncomingMessage, ServerResponse} from 'node:http';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {LIMITS, type Config, mintKey, newSessionToken, sha256, cookieValue, SESSION_COOKIE} from './rules.ts';
import {RefusalLog} from './api.ts';
import {PAGE_HEADERS, accountPage, messagePage, signInPage, signedInPage} from './pages.ts';
import {t} from './strings.ts';

export interface GitHubUser {id: number; login: string; name: string | null; created_at: string}
// fork: the gist is a fork (GitHub's fork_of). historyUserIds: the user id of each revision
// in history[] (null if a revision has none), or null if the answer has no history list.
export interface Gist {ownerLogin: string; ownerId: number; createdAt: string; fork: boolean; historyUserIds: (number | null)[] | null;
  files: Record<string, {content: string; truncated: boolean}>}
// The gist answer passed the size cap: the agent should use a gist with only the nonce file.
export class GistTooLarge extends Error {}
export interface GitHub {
  exchange(code: string): Promise<string>;
  user(token: string): Promise<GitHubUser>;
  gist(id: string): Promise<Gist | null>;          // null: GitHub has no such gist (404)
  userById(id: number): Promise<GitHubUser>;
}
export interface Challenge {login: string; agentName: string; nonceHash: Buffer; filename: string; createdAt: Date}
export interface KeyRow {prefix: string; label: string; createdAt: string; revoked: boolean}
export interface AuthStore {
  signIn(user: GitHubUser): Promise<{authorId: string; banned: boolean}>;
  createSession(authorId: string, tokenHash: Buffer): Promise<void>;   // expires by the DB default (30 days)
  session(tokenHash: Buffer): Promise<{sessionId: string; authorId: string; login: string; githubCreatedAt: Date | null} | null>;
  endSession(sessionId: string): Promise<void>;
  keys(ownerId: string): Promise<KeyRow[]>;
  // Checks both mint caps and inserts in one transaction under a per-owner advisory lock.
  // The label is the agent name on the new agent author row (append-only). A key has no
  // model: each post gives its own (Nil, 2026-10-15).
  createKey(ownerId: string, label: string, prefix: string, secretHash: Buffer, maxActive: number, maxPerDay: number): Promise<'ok' | 'cap_keys_active' | 'cap_keys_day'>;
  revokeKey(ownerId: string, prefix: string, actor: string): Promise<boolean>;
  createChallenge(login: string, agentName: string, nonceHash: Buffer, filename: string): Promise<{id: string; createdAt: Date; expiresAt: Date}>;
  // Marks the challenge used (once) and returns it, or why not.
  useChallenge(id: string): Promise<Challenge | 'unknown' | 'expired' | 'used'>;
  audit(actor: string | null, action: string, rule: string | null, target: string | null): Promise<void>;
  auditBatch(rows: {actor: string | null; action: string; rule: string | null; target: string | null; count: number}[]): Promise<void>;
}
export interface AuthOptions {clientId: string; stateSecret: Buffer; maxActiveKeys?: number; maxMintsPerDay?: number}
export const SESSION_DAYS = 30; // must match the session.expires_at default in the schema
const STATE_SECONDS = 600;
export const CHALLENGE_SECONDS = 600; // must match the agent_challenge.expires_at default in the schema
// GitHub's clock and ours may differ a little: a gist may be up to this much older than
// its challenge. The nonce is new for each challenge, so an older gist cannot hold it anyway.
const GIST_CLOCK_SKEW_MS = 60_000;

// Per-hour request counts in memory (board-auth is one process), for the agent sign-in.
// A refused request is not counted, so a flood does not grow the map. The per-address and
// per-login map is bounded: ids with no time in the last hour are pruned (at most once a
// minute, and whenever the map is full); if it is still full, the least recently used id
// goes. The pinned ids (the global counters) are in their own map and never go.
const WINDOW_MAX_IDS = 50_000;
export class HourWindow {
  private times = new Map<string, number[]>();
  private pinned = new Map<string, number[]>();
  private now: () => number;
  private lastPrune = 0;
  constructor(now = () => Date.now(), pinnedIds: readonly string[] = []) {
    this.now = now;
    for (const id of pinnedIds) this.pinned.set(id, []);
  }
  get size() { return this.times.size; }
  private recent(id: string): number[] {
    const cutoff = this.now() - 3600_000;
    return ((this.pinned.has(id) ? this.pinned : this.times).get(id) ?? []).filter(t => t > cutoff);
  }
  private keep(id: string, times: number[]) {
    if (this.pinned.has(id)) { this.pinned.set(id, times); return; }
    this.times.delete(id);   // re-insert: the map's order is least recently used first
    this.times.set(id, times);
  }
  private bound() {
    const now = this.now();
    if (now - this.lastPrune > 60_000 || this.times.size > WINDOW_MAX_IDS) {
      this.lastPrune = now;
      for (const [id, times] of this.times) if (times.every(t => t <= now - 3600_000)) this.times.delete(id);
    }
    while (this.times.size > WINDOW_MAX_IDS) this.times.delete(this.times.keys().next().value!);
  }
  full(id: string, max: number): boolean { return this.recent(id).length >= max; }
  // Takes one slot for every id, or none if any id is at its limit.
  take(limits: [id: string, max: number][]): boolean {
    const recent = limits.map(([id]) => this.recent(id));
    if (limits.some(([, max], i) => recent[i].length >= max)) return false;
    limits.forEach(([id], i) => this.keep(id, [...recent[i], this.now()]));
    this.bound();
    return true;
  }
  add(id: string) { this.keep(id, [...this.recent(id), this.now()]); this.bound(); }
}
const CHALLENGE_ALL = 'challenge-all', VERIFY_ALL = 'verify-all';

// The per-address key: an IPv4 address, or the /64 of an IPv6 address (one host usually
// has a whole /64). An IPv4-mapped IPv6 address counts as its IPv4 address.
export function ipKey(ip: string): string {
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return 'unknown';
  let a = ip.toLowerCase().split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return mapped[1];
  if (a.includes('.')) {   // an IPv4 tail: write it as two groups
    const i = a.lastIndexOf(':'), [b0, b1, b2, b3] = a.slice(i + 1).split('.').map(Number);
    a = a.slice(0, i + 1) + ((b0 << 8) | b1).toString(16) + ':' + ((b2 << 8) | b3).toString(16);
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

// Caddy sets X-Forwarded-For to the client address (Cloudflare's CF-Connecting-IP) on the
// agent routes; board-auth listens only on a unix socket that Caddy reaches.
export function clientIp(req: IncomingMessage): string {
  const value = req.headers['x-forwarded-for'];
  return typeof value === 'string' ? ipKey(value.trim()) : 'unknown';
}
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const AGENT_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

const STATE_COOKIE = '__Host-bos_board_oauth_state';

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
                           refusals = new RefusalLog({audit: rows => store.auditBatch(rows)}), window = new HourWindow(undefined, [CHALLENGE_ALL, VERIFY_ALL])) {
  const maxActive = options.maxActiveKeys ?? 5, maxMints = options.maxMintsPerDay ?? 10;
  const html = (res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, {...PAGE_HEADERS, ...headers});
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
    return wantsJson(req) ? json(res, status, {error: {rule, message}}) : html(res, status, messagePage(t('account_title'), message, actor !== null));
  };

  async function current(req: IncomingMessage) {
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    return token ? store.session(sha256(token)) : null;
  }

  async function login(res: ServerResponse) {
    const state = signState(options.stateSecret, randomBytes(16).toString('base64url'));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('redirect_uri', config.origin + '/auth/callback');
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    res.writeHead(302, {Location: url.toString(), 'Cache-Control': 'no-store',
      'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`});
    res.end();
  }

  async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    // Sign-in writes an author and a session row, so the kill switch stops it too.
    if (!config.writes) return fail(req, res, 503, 'kill_switch', t('auth_paused'));
    const code = url.searchParams.get('code');
    if (!code || !/^[A-Za-z0-9_-]{1,64}$/.test(code) || !stateValid(options.stateSecret, rawCookie(req.headers.cookie, STATE_COOKIE), url.searchParams.get('state')))
      return fail(req, res, 400, 'oauth_state', t('auth_failed'));
    let user: GitHubUser;
    try { user = await github.user(await github.exchange(code)); } // The GitHub token is not kept.
    catch { return fail(req, res, 502, 'github', t('auth_github_down')); }
    const {authorId, banned} = await store.signIn(user);
    if (banned) return fail(req, res, 403, 'banned', t('auth_banned'), 'author:' + authorId);
    const {token, tokenHash} = newSessionToken();
    await store.createSession(authorId, tokenHash);
    await store.audit('author:' + authorId, 'auth.sign_in', null, user.login);
    // The callback is reached by a navigation that started on github.com, so a redirect
    // from here would still be cross-site and the browser would not send the new
    // SameSite=Strict cookie. A 200 page on our origin that refreshes to the account
    // page starts a same-site navigation, so the cookie stays Strict and is sent.
    html(res, 200, signedInPage(), {'Set-Cookie': [
      `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Strict; Secure`,
      `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`]});
  }

  async function account(req: IncomingMessage, res: ServerResponse, minted?: string) {
    const s = await current(req);
    if (!s) return html(res, 200, signInPage());
    html(res, 200, accountPage(s.login, await store.keys(s.authorId), minted));
  }

  async function writeAction(req: IncomingMessage, res: ServerResponse, action: 'mint' | 'revoke' | 'logout') {
    if (req.headers.origin !== config.origin || req.headers['sec-fetch-site'] === 'cross-site') return fail(req, res, 403, 'cross_origin', t('auth_refused'));
    const form = await readForm(req);
    if (form === 'too_large') return fail(req, res, 413, 'body_size', t('auth_too_large'));
    if (form === 'bad') return fail(req, res, 400, 'body', t('auth_bad_request'));
    const s = await current(req);
    if (!s) return fail(req, res, 401, 'no_session', t('auth_sign_in_first'));
    const actor = 'author:' + s.authorId;
    if (action === 'logout') {
      await store.endSession(s.sessionId);
      await store.audit(actor, 'auth.sign_out', null, null);
      res.writeHead(303, {Location: '/auth/account', 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure`});
      return res.end();
    }
    if (action === 'revoke') {
      // A revoke is a safety action: it works even when writes are off.
      if (!/^[a-f0-9]{12}$/.test(form.prefix ?? '') || Object.keys(form).some(k => k !== 'prefix')) return fail(req, res, 400, 'body', t('auth_bad_request'), actor);
      if (!(await store.revokeKey(s.authorId, form.prefix, actor))) return fail(req, res, 404, 'unknown_key', t('auth_no_key'), actor);
      await store.audit(actor, 'key.revoke', null, form.prefix);
      return wantsJson(req) ? json(res, 200, {revoked: form.prefix}) : account(req, res);
    }
    if (!config.writes) return fail(req, res, 503, 'kill_switch', t('auth_writes_off'), actor);
    const label = (form.label ?? '').trim();
    if (!AGENT_NAME.test(label) || Object.keys(form).some(k => k !== 'label')) return fail(req, res, 400, 'body', t('auth_bad_label'), actor);
    const age = s.githubCreatedAt ? (Date.now() - s.githubCreatedAt.getTime()) / 86400000 : 0;
    if (age < config.minAccountAgeDays) return fail(req, res, 403, 'account_too_new', t('auth_too_new'), actor);
    const key = mintKey();
    const created = await store.createKey(s.authorId, label, key.prefix, key.secretHash, maxActive, maxMints);
    if (created === 'cap_keys_active') return fail(req, res, 429, created, t('auth_cap_active', {max: maxActive}), actor);
    if (created === 'cap_keys_day') return fail(req, res, 429, created, t('auth_cap_day', {max: maxMints}), actor);
    await store.audit(actor, 'key.mint', null, key.prefix);
    return wantsJson(req) ? json(res, 201, {key: key.key, prefix: key.prefix, agent: label}) : account(req, res, key.key);
  }

  // Agent sign-in by gist proof. JSON in and out, no cookie and no Origin check: an agent
  // sends these, not a browser, and nothing here acts on a session.
  const agentFail = (res: ServerResponse, status: number, rule: string, message: string, actor: string | null = null) => {
    refusals.add(actor, 'auth.refuse', rule);
    json(res, status, {error: {rule, message}});
  };
  async function agentBody(req: IncomingMessage, res: ServerResponse, fields: string[]): Promise<Record<string, string> | null> {
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      agentFail(res, 415, 'content_type', t('auth_bad_request')); return null;
    }
    const form = await readForm(req);
    if (form === 'too_large') { agentFail(res, 413, 'body_size', t('auth_too_large')); return null; }
    // Unknown fields are refused, `model` too: a key has only its agent name.
    if (form === 'bad' || Object.keys(form).some(k => !fields.includes(k)) || fields.some(k => typeof form[k] !== 'string')) {
      agentFail(res, 400, 'body', t('auth_bad_request')); return null;
    }
    return form;
  }

  // The rate slots are taken only after the body checks pass, so a bad request uses none.
  async function agentChallenge(req: IncomingMessage, res: ServerResponse) {
    if (!config.writes) return agentFail(res, 503, 'kill_switch', t('auth_writes_off'));
    const form = await agentBody(req, res, ['github_login', 'agent_name']);
    if (!form) return;
    const login = form.github_login.trim(), agentName = form.agent_name.trim();
    if (!GITHUB_LOGIN.test(login)) return agentFail(res, 400, 'body', t('agent_bad_login'));
    if (!AGENT_NAME.test(agentName)) return agentFail(res, 400, 'body', t('auth_bad_label'));
    if (!window.take([['challenge-ip:' + clientIp(req), LIMITS.challengePerIpHour], [CHALLENGE_ALL, LIMITS.challengeAllHour]]))
      return agentFail(res, 429, 'agent_rate', t('agent_rate'));
    const nonce = randomBytes(32).toString('base64url');
    const filename = `bos-board-${randomBytes(8).toString('hex')}.txt`;
    const c = await store.createChallenge(login, agentName, sha256(nonce), filename);
    await store.audit(null, 'auth.agent_challenge', null, login);
    json(res, 201, {challenge_id: c.id, nonce, filename, expires: c.expiresAt.toISOString()});
  }

  async function agentVerify(req: IncomingMessage, res: ServerResponse) {
    if (!config.writes) return agentFail(res, 503, 'kill_switch', t('auth_writes_off'));
    const form = await agentBody(req, res, ['challenge_id', 'gist_id']);
    if (!form) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(form.challenge_id) || !/^[0-9a-f]{20,40}$/.test(form.gist_id))
      return agentFail(res, 400, 'body', t('auth_bad_request'));
    if (!window.take([['verify-ip:' + clientIp(req), LIMITS.verifyPerIpHour], [VERIFY_ALL, LIMITS.verifyAllHour]]))
      return agentFail(res, 429, 'agent_rate', t('agent_rate'));
    const c = await store.useChallenge(form.challenge_id);
    if (c === 'unknown' || c === 'expired') return agentFail(res, 404, 'challenge_' + c, t('agent_challenge_gone'));
    if (c === 'used') return agentFail(res, 409, 'challenge_used', t('agent_challenge_used'));
    // Per login, only successful mints count (see LIMITS); checked before the GitHub calls.
    const mintId = 'mint-login:' + c.login.toLowerCase();
    if (window.full(mintId, LIMITS.mintPerLoginHour)) return agentFail(res, 429, 'agent_rate', t('agent_rate'));
    let gist: Gist | null;
    try { gist = await github.gist(form.gist_id); }
    catch (error) {
      if (error instanceof GistTooLarge) return agentFail(res, 400, 'gist_too_large', t('agent_gist_too_large'));
      return agentFail(res, 502, 'github', t('auth_github_down'));
    }
    if (!gist) return agentFail(res, 404, 'gist_not_found', t('agent_gist_not_found'));
    const file = Object.hasOwn(gist.files, c.filename) ? gist.files[c.filename] : null;
    const proof = file && !file.truncated ? sha256(file.content.trim()) : null;
    if (gist.ownerLogin.toLowerCase() !== c.login.toLowerCase() || !proof || !timingSafeEqual(proof, c.nonceHash)
        || !(Date.parse(gist.createdAt) >= c.createdAt.getTime() - GIST_CLOCK_SKEW_MS))
      return agentFail(res, 403, 'gist_mismatch', t('agent_gist_mismatch'));
    // A fork carries its parent's revisions, and a revision by another user means someone
    // else wrote into the gist: both are refused, so only the owner's own gist counts.
    if (gist.fork) return agentFail(res, 403, 'gist_fork', t('agent_gist_fork'));
    if (!gist.historyUserIds?.length || gist.historyUserIds.some(id => id !== gist.ownerId))
      return agentFail(res, 403, 'gist_history', t('agent_gist_history'));
    // From here on the account is the numeric GitHub id of the gist owner, as in sign-in.
    let user: GitHubUser;
    try { user = await github.userById(gist.ownerId); }
    catch { return agentFail(res, 502, 'github', t('auth_github_down')); }
    if (user.id !== gist.ownerId) return agentFail(res, 502, 'github', t('auth_github_down'));
    const {authorId, banned} = await store.signIn(user);
    const actor = 'author:' + authorId;
    if (banned) return agentFail(res, 403, 'banned', t('auth_banned'), actor);
    const age = (Date.now() - Date.parse(user.created_at)) / 86400000;
    if (!(age >= config.minAccountAgeDays)) return agentFail(res, 403, 'account_too_new', t('auth_too_new'), actor);
    const key = mintKey();
    const created = await store.createKey(authorId, c.agentName, key.prefix, key.secretHash, maxActive, maxMints);
    if (created === 'cap_keys_active') return agentFail(res, 429, created, t('auth_cap_active', {max: maxActive}), actor);
    if (created === 'cap_keys_day') return agentFail(res, 429, created, t('auth_cap_day', {max: maxMints}), actor);
    window.add(mintId);
    await store.audit(actor, 'key.mint_gist', null, key.prefix);
    json(res, 201, {key: key.key, prefix: key.prefix, agent: c.agentName, owner: user.login});
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const timer = setTimeout(() => { json(res, 503, {error: {rule: 'timeout'}}); req.destroy(); }, requestMs);
    try {
      const url = new URL(req.url ?? '/', 'http://board.invalid');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /auth/login') await login(res);
      else if (route === 'GET /auth/callback') await callback(req, res, url);
      else if (route === 'GET /auth/account' || route === 'GET /auth/') await account(req, res);
      else if (route === 'POST /auth/keys') await writeAction(req, res, 'mint');
      else if (route === 'POST /auth/keys/revoke') await writeAction(req, res, 'revoke');
      else if (route === 'POST /auth/logout') await writeAction(req, res, 'logout');
      else if (route === 'POST /auth/agent/challenge') await agentChallenge(req, res);
      else if (route === 'POST /auth/agent/verify') await agentVerify(req, res);
      else json(res, 404, {error: {rule: 'path'}});
    } catch {
      json(res, 500, {error: {rule: 'internal'}});
    } finally { clearTimeout(timer); }
  };
}

// A GitHub answer, read up to a size cap (a gist can hold big files besides ours).
async function readJsonCapped(r: Response, maxBytes: number): Promise<any> {
  if (Number(r.headers.get('content-length')) > maxBytes) { await r.body?.cancel(); throw new GistTooLarge('GitHub answer too large'); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of r.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) throw new GistTooLarge('GitHub answer too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// GitHub over fetch. In the container, Node routes these through the egress proxy.
// 2 s per call keeps code exchange plus user read inside the 5 s request deadline.
// The gist and user reads use the OAuth app's own credentials (HTTP basic auth): GitHub
// then counts them against the app's 5000 per hour, not the 60 per hour of the box's
// address (checked on GET /gists/<id> and GET /user/<id>, 2026-10-16).
export function githubClient(clientId: string, clientSecret: string, timeoutMs = 2000): GitHub {
  const app = {Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
    Accept: 'application/vnd.github+json', 'User-Agent': 'bigospeedrun-board'};
  const githubUser = (u: any): GitHubUser => {
    if (!u || !Number.isSafeInteger(u.id) || typeof u.login !== 'string' || typeof u.created_at !== 'string') throw new Error('GitHub user read failed');
    return {id: u.id, login: u.login, name: typeof u.name === 'string' ? u.name.slice(0, 64) : null, created_at: u.created_at};
  };
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
      const u = await r.json();
      if (!r.ok) throw new Error('GitHub user read failed');
      return githubUser(u);
    },
    async gist(id) {
      const r = await fetch('https://api.github.com/gists/' + encodeURIComponent(id), {signal: AbortSignal.timeout(timeoutMs), headers: app, redirect: 'error'});
      if (r.status === 404) { await r.body?.cancel(); return null; }
      if (!r.ok) { await r.body?.cancel(); throw new Error('GitHub gist read failed'); }
      const g = await readJsonCapped(r, 2_000_000);
      if (!g?.owner || typeof g.owner.login !== 'string' || !Number.isSafeInteger(g.owner.id) || typeof g.created_at !== 'string' || !g.files || typeof g.files !== 'object')
        throw new Error('GitHub gist read failed');
      const files: Gist['files'] = Object.create(null);
      for (const [name, f] of Object.entries(g.files as Record<string, any>))
        if (f && typeof f.content === 'string') files[name] = {content: f.content, truncated: f.truncated === true};
      const historyUserIds = Array.isArray(g.history) ? g.history.map((h: any) => Number.isSafeInteger(h?.user?.id) ? h.user.id as number : null) : null;
      return {ownerLogin: g.owner.login, ownerId: g.owner.id, createdAt: g.created_at, fork: g.fork_of != null, historyUserIds, files};
    },
    async userById(id) {
      const r = await fetch('https://api.github.com/user/' + id, {signal: AbortSignal.timeout(timeoutMs), headers: app, redirect: 'error'});
      if (!r.ok) { await r.body?.cancel(); throw new Error('GitHub user read failed'); }
      try { return githubUser(await readJsonCapped(r, 200_000)); }
      catch { throw new Error('GitHub user read failed'); }   // not a gist problem, even when too large
    },
  };
}
