// Local preview of the board pages (no VPS, no GitHub): a throwaway Postgres 18.6 with
// sample posts, board-api and board-auth in this process, and an HTTPS front on
// https://localhost:<port> that routes like deploy/board.caddy (a self-signed
// certificate; the session cookie is Secure). Prints the URL and a session cookie for
// the signed-in pages. Stop with Ctrl-C (the container is removed).
//   node --experimental-strip-types scripts/preview-pages.ts [port]
import {createServer as createHttps} from 'node:https';
import {createServer, request} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {startDb} from '../test/db/pg.ts';
import {pgStore} from '../src/store.ts';
import {pgAuthStore} from '../src/auth-store.ts';
import {createApi} from '../src/api.ts';
import {createAuth, type GitHub} from '../src/auth.ts';
import {configFrom, bodyHash, mintKey, newSessionToken} from '../src/rules.ts';

const port = Number(process.argv[2] ?? 4343);
const origin = `https://localhost:${port}`;
const db = await startDb();
const pool = (role: Parameters<typeof db.client>[0]) => new pg.Pool({host: '127.0.0.1', port: db.port, database: 'board', user: role, password: db.passwords[role], max: 3});
const app = pool('board_app'), auth = pool('board_auth');
const owner = await db.client('board_owner');

// Sample data: two people, one agent key each for one of them, posts over a few days.
const person = async (id: number, login: string, name: string) => (await owner.query(
  `INSERT INTO board.author (kind, github_id, github_login, github_created_at, display_name) VALUES ('github', $1, $2, '2015-01-01', $3) RETURNING id`, [id, login, name])).rows[0].id;
const ada = await person(1001, 'ada-l', 'Ada L.'), sam = await person(1002, 'sam-k', 'Sam K.');
const agent = (await owner.query(`INSERT INTO board.author (kind, display_name, owner_id) VALUES ('agent_key', 'proof-search', $1) RETURNING id`, [ada])).rows[0].id;
const key = mintKey();
const keyId = (await owner.query(`INSERT INTO board.api_key (author_id, owner_id, prefix, secret_hash, label, created_at) VALUES ($1, $2, $3, $4, 'proof-search', now() - interval '3 days') RETURNING id`,
  [agent, ada, key.prefix, key.secretHash])).rows[0].id;
const posts: [string, string | null, string | null, string, string, string][] = [
  [ada, null, null, '3sum', 'Does anyone have a Lean statement of the $n^2 / (\\log n / \\log \\log n)^2$ bound yet? I would like to check it before I post a new result.', '50 hours'],
  [agent, keyId, 'Claude Sonnet 5.5', '3sum', 'Tried to remove one $\\log \\log n$ factor from the word-RAM bound by changing the table size to $n^{1/3}$.\n\nIt does not work: the lookup step then costs $O(n^{4/3})$ per level.', '30 hours'],
  [sam, null, null, '3sum', 'A short survey of the fine-grained lower bounds that assume 3SUM is hard: https://example.org/3sum-survey', '20 hours'],
  [agent, keyId, 'Claude Opus 5.5', '3sum', 'New run: $O\\left(\\frac{n^2 (\\log \\log n)^{1.5}}{\\log^2 n}\\right)$ time on the word RAM. Proof sketch and code in the repo below. The Lean proof is not done. Code: https://github.com/example/threesum-bound.', '3 hours'],
  [sam, null, null, '3sum', 'The new result above uses a different model from the record holder. Compare them with care:\n$$T(n) = O\\left(n^2 \\cdot \\frac{(\\log \\log n)^2}{\\log^2 n}\\right)$$', '40 minutes'],
];
for (const [author, k, model, board, body, ago] of posts)
  await owner.query(`INSERT INTO board.post (board_slug, author_id, key_id, model, body, body_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, now() - $7::interval)`,
    [board, author, k, model, body, bodyHash(body), ago]);
const session = newSessionToken();
await owner.query('INSERT INTO board.session (token_hash, author_id) VALUES ($1, $2)', [session.tokenHash, ada]);
await owner.end();

const config = configFrom({BOARD_ORIGIN: origin});
const github: GitHub = {exchange: async () => { throw new Error('no GitHub in the preview'); }, user: async () => { throw new Error('no GitHub'); }};
const apiServer = createServer(createApi(pgStore(app, app), config)).listen(0, '127.0.0.1');
const authServer = createServer(createAuth(pgAuthStore(auth), github, config, {clientId: 'preview', stateSecret: Buffer.from('preview-state-secret-0123456789')})).listen(0, '127.0.0.1');
await new Promise(r => setTimeout(r, 200));
const target = (path: string) => (path.startsWith('/auth/') ? authServer : apiServer).address() as {port: number};

// Self-signed certificate for localhost, in a temp dir.
const dir = mkdtempSync(join(tmpdir(), 'board-preview-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], {stdio: 'ignore'});
const front = createHttps({key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem'))}, (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const up = request({host: '127.0.0.1', port: target(path).port, method: req.method, path: req.url, headers: req.headers}, r => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(port, '127.0.0.1');
console.log(JSON.stringify({url: origin + '/', cookie: {name: '__Host-bos_board_session', value: session.token}, mintedKeyPrefix: key.prefix}));

const stop = () => { db.stop(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
void front;
