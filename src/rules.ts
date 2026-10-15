// Pure board rules: config, request schema, body normalization, key and cookie
// formats. No I/O here, so the unit tests cover them fast.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import Ajv from 'ajv';

export const LIMITS = {
  postBodyBytes: 8 * 1024,   // HTTP body cap for POST /board/api/posts (Caddy has the same)
  authBodyBytes: 2 * 1024,   // HTTP body cap for /board/auth/*
  bodyChars: 4000,
  links: 5,
  linkChars: 300,
  perKeyHour: 10,
  perAccountHour: 20,
  perBoardHour: 60,
  repeatAuthorHours: 24,
  repeatBoardHours: 1,
  requestMs: 5000,
  readLimitDefault: 50,
  readLimitMax: 100,
  minAccountAgeDays: 30,
} as const;

export interface Config {writes: boolean; origin: string; minAccountAgeDays: number}

export function configFrom(env: NodeJS.ProcessEnv): Config {
  const writes = (env.BOARD_WRITES ?? 'on').trim().toLowerCase();
  if (writes !== 'on' && writes !== 'off') throw new Error('BOARD_WRITES must be on or off');
  const origin = env.BOARD_ORIGIN ?? 'https://bigospeedrun.com';
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) throw new Error('BOARD_ORIGIN must be a scheme and host');
  return {writes: writes === 'on', origin, minAccountAgeDays: Number(env.BOARD_MIN_ACCOUNT_AGE_DAYS ?? LIMITS.minAccountAgeDays)};
}

export const KINDS = ['note', 'result', 'failed_attempt', 'question', 'link'] as const;

// Strict request schema: unknown fields, wrong types and oversized values all fail.
export const postSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['board', 'kind', 'body'],
  properties: {
    board: {type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$'},
    kind: {enum: [...KINDS]},
    body: {type: 'string', minLength: 1, maxLength: LIMITS.bodyChars},
    links: {type: 'array', maxItems: LIMITS.links, uniqueItems: true,
            items: {type: 'string', maxLength: LIMITS.linkChars, pattern: '^https://[^\\s<>"]+$'}},
  },
} as const;

const ajv = new Ajv({strict: true, allErrors: false});
export const validatePost = ajv.compile(postSchema);

export interface PostInput {board: string; kind: typeof KINDS[number]; body: string; links: string[]}

// No HTML and no images: the board shows plain text only.
export function contentProblem(body: string): string | null {
  if (/<\s*[a-zA-Z!\/?]/.test(body)) return 'html';
  if (/!\[[^\]]*\]\(/.test(body)) return 'image';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) return 'control_chars';
  return null;
}

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

export const SESSION_COOKIE = 'bos_board_session';

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

// Read cursor: "<ISO time>_<uuid>" of the last post seen.
export function parseCursor(after: string | null): {at: string; id: string} | null | 'invalid' {
  if (!after) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)_([0-9a-f-]{36})$/.exec(after);
  return match ? {at: match[1], id: match[2]} : 'invalid';
}
