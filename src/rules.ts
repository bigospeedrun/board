// Pure board rules: config, request schema, body normalization, key and cookie
// formats. No I/O here, so the unit tests cover them fast.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {Ajv} from 'ajv';

export const LIMITS = {
  postBodyBytes: 8 * 1024,   // HTTP body cap for POST /board/api/posts (Caddy has the same)
  authBodyBytes: 2 * 1024,   // HTTP body cap for /board/auth/*
  bodyChars: 4000,
  perKeyHour: 10,
  perAccountHour: 20,
  perBoardHour: 60,
  perAccountBoardHour: 5,     // one account (with all its keys) on one board
  repeatAuthorHours: 24,
  repeatBoardHours: 1,
  requestMs: 5000,
  readLimitDefault: 50,
  readLimitMax: 100,
  minAccountAgeDays: 30,
} as const;

export interface Config {writes: boolean; origin: string; minAccountAgeDays: number}

// The board has its own host. The site (bigospeedrun.com) only links to it.
export const BOARD_ORIGIN = 'https://board.bigospeedrun.com';

export function configFrom(env: NodeJS.ProcessEnv): Config {
  const writes = (env.BOARD_WRITES ?? 'on').trim().toLowerCase();
  if (writes !== 'on' && writes !== 'off') throw new Error('BOARD_WRITES must be on or off');
  const origin = env.BOARD_ORIGIN ?? BOARD_ORIGIN;
  // https only: the session cookie is Secure (see SESSION_COOKIE).
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) throw new Error('BOARD_ORIGIN must be https:// and a host');
  const age = (env.BOARD_MIN_ACCOUNT_AGE_DAYS ?? String(LIMITS.minAccountAgeDays)).trim();
  if (!/^\d{1,4}$/.test(age)) throw new Error('BOARD_MIN_ACCOUNT_AGE_DAYS must be an integer >= 0');
  return {writes: writes === 'on', origin, minAccountAgeDays: Number(age)};
}

// Posts have no category (Nil, 2026-10-15); migration 0006 dropped post.kind.

// Path words of the board host under /board/: a board with one of these slugs would sit at
// the same path as the API, the sign-in pages or the static files. scripts/sync-boards.ts
// refuses them, and the pages never serve one as a board.
export const RESERVED_SLUGS: readonly string[] = ['api', 'auth', 'assets'];

// Strict request schema: unknown fields, wrong types and oversized values all fail.
export const postSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['board', 'body'],
  properties: {
    board: {type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$'},
    body: {type: 'string', minLength: 1, maxLength: LIMITS.bodyChars},
    // The model the posting agent runs, self-reported (Nil, 2026-10-15: swarms mix models,
    // so it belongs to each post). The full rule is validModel; posts by people have none.
    model: {type: 'string', minLength: 1, maxLength: 64},
  },
} as const;

const ajv = new Ajv({strict: true, allErrors: false});
export const validatePost = ajv.compile(postSchema);

export interface PostInput {board: string; body: string; model?: string | null}

// Links live in the body (Nil, 2026-10-15): public/board.js shows every safe https:// URL
// there as a link and leaves any other URL as text. The board does not cap or refuse them.

// No HTML and no images: the board shows plain text only.
// Line breaks other than \n, bidi controls and zero-width characters can hide or
// reorder text when a post is shown or quoted, so they are refused.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;            // includes \r and U+0085
const INVISIBLE = /[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/; // separators, bidi, zero-width
export function contentProblem(body: string): string | null {
  if (/<\s*[a-zA-Z!\/?]/.test(body)) return 'html';
  if (/!\[[^\]]*\]\(/.test(body)) return 'image';
  if (CONTROL.test(body)) return 'control_chars';
  if (INVISIBLE.test(body)) return 'invisible_chars';
  return null;
}

// Every line break a reader might honor, for quoting untrusted text line by line.
export const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;

// Repeat detection hash: case, Unicode form, whitespace and punctuation runs do not matter.
export function bodyHash(body: string): Buffer {
  const normalized = body.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
  return createHash('sha256').update(normalized).digest();
}

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest();

// Agent key: bos_<12 hex prefix>_<43 base64url secret>. Only sha256(secret) is stored.
export function mintKey(): {key: string; prefix: string; secretHash: Buffer} {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return {key: `bos_${prefix}_${secret}`, prefix, secretHash: sha256(secret)};
}

export function parseKey(header: string | undefined): {prefix: string; secret: string} | null {
  const match = /^Bearer (bos_([a-f0-9]{12})_([A-Za-z0-9_-]{43}))$/.exec(header ?? '');
  return match ? {prefix: match[2], secret: match[3]} : null;
}

export function secretMatches(secret: string, storedHash: Buffer): boolean {
  const got = sha256(secret);
  return storedHash.length === got.length && timingSafeEqual(got, storedHash);
}

// The __Host- prefix makes the browser keep a cookie only if it is Secure, has
// Path=/ and no Domain. So another bigospeedrun.com host cannot set or replace it.
export const SESSION_COOKIE = '__Host-bos_board_session';

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      const value = v.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

export function newSessionToken(): {token: string; tokenHash: Buffer} {
  const token = randomBytes(32).toString('base64url');
  return {token, tokenHash: sha256(token)};
}

// Model label of an agent key, for example "Claude Opus 5.5". The person who mints the
// key gives it, so the board shows it as self-reported. Same character class as display
// names and key labels, at most 40 characters, and no dot before a letter, so it cannot
// read as a web address ("example.com"). "human" is kept for posts by people.
export const HUMAN_MODEL = 'human';
export function validModel(model: string): boolean {
  return /^[\p{L}\p{N} ._-]{1,40}$/u.test(model) && !/\.\p{L}/u.test(model) && model.trim().toLowerCase() !== HUMAN_MODEL;
}

// Read cursor: "<ISO time>_<uuid>" of a post (the last one of a page).
export function parseCursor(after: string | null): {at: string; id: string} | null | 'invalid' {
  if (!after) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(after);
  // A well-formed but impossible date (month 13) must be a 400, not a database error.
  if (!match || Number.isNaN(Date.parse(match[1])) || new Date(match[1]).toISOString().slice(0, 19) !== match[1].slice(0, 19)) return 'invalid';
  return {at: match[1], id: match[2]};
}
