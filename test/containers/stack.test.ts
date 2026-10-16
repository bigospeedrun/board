// Playbook item 11 negative tests on the real stack: the board image, the compose
// fragment and board.caddy in a test Caddy container, all on this machine (no VPS).
// Every request goes Caddy -> unix socket -> service -> Postgres socket.
// Must fail: forbidden path, oversized body, unknown field, cap overrun, kill switch,
// outbound attempt (api, db, auth direct, auth via proxy to a non-GitHub host),
// a passwordless or wrong-role DB login, and writes to the read-only root fs.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const BOARD = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE = 'bigospeedrun-board:test';
const CADDY = 'caddy:2.11@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af';
const project = 'bosboardtest' + randomBytes(3).toString('hex');
const work = mkdtempSync(join(tmpdir(), 'bos-board-stack-'));
const secrets = join(work, 'secrets'), apiSockets = join(work, 'run-api'), authSockets = join(work, 'run-auth');
const env = {...process.env, BOARD_IMAGE: IMAGE, BOARD_SECRETS_DIR: secrets, BOARD_API_SOCKET_DIR: apiSockets, BOARD_AUTH_SOCKET_DIR: authSockets, BOARD_WRITES: 'on', BOARD_SOCKET_GID: '10001'};
const files = ['-f', join(BOARD, 'deploy/compose.board.yml'), '-f', join(work, 'test.override.yml')];
const compose = (args: string[], extraEnv: Record<string, string> = {}) => {
  const r = spawnSync('docker', ['compose', '-p', project, ...files, ...args], {env: {...env, ...extraEnv}, encoding: 'utf8'});
  if (r.status !== 0) throw new Error(`docker compose ${args[0]} failed: ${(r.stderr || '').slice(-1500)}`);
  return r.stdout;
};
const exec = (service: string, ...cmd: string[]) =>
  spawnSync('docker', ['compose', '-p', project, ...files, 'exec', '-T', service, ...cmd], {env, encoding: 'utf8'});
let base = '', key = '';

before(async () => {
  execFileSync('docker', ['build', '-q', '-f', join(BOARD, 'Dockerfile'), '-t', IMAGE, BOARD], {stdio: 'ignore'});
  mkdirSync(secrets); mkdirSync(apiSockets); mkdirSync(authSockets);
  for (const dir of [apiSockets, authSockets]) chmodSync(dir, 0o777); // test only; production: group wg-caddy, mode 2770
  const owner = randomBytes(24).toString('base64url');
  for (const [name, value] of Object.entries({owner_password: owner, owner_password_node: owner, app_password: randomBytes(24).toString('base64url'),
      auth_password: randomBytes(24).toString('base64url'), admin_password: randomBytes(24).toString('base64url'), dump_password: randomBytes(24).toString('base64url'),
      github_client_secret: randomBytes(20).toString('hex'), state_secret: randomBytes(32).toString('base64url')})) {
    writeFileSync(join(secrets, name), value + '\n'); chmodSync(join(secrets, name), 0o444); // test only; production 0440 + group
  }
  // Same shape as production (board.bigospeedrun.com { import board.caddy }), on plain :8080.
  writeFileSync(join(work, 'Caddyfile'), `{\n\tadmin off\n\tauto_https off\n\tstorage file_system /tmp/caddy\n}\n:8080 {\n\timport /etc/caddy/board.caddy\n}\n`);
  // Test-only front: Caddy with the production board.caddy, published on a random local port.
  writeFileSync(join(work, 'test.override.yml'), `services:
  board-caddy:
    image: ${CADDY}
    user: '10001:10001'           # test only: the socket dirs cannot carry wg-caddy's group here,
    group_add: ['10002']          # so this Caddy joins the api (10001) and auth (10002) groups
    read_only: true
    tmpfs: [/tmp, /config, /data]
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]   # the caddy binary carries this file capability; exec fails without it
    command: [caddy, run, --config, /etc/caddy/Caddyfile, --adapter, caddyfile]
    ports: ['127.0.0.1::8080']
    volumes:
      - ${join(work, 'Caddyfile')}:/etc/caddy/Caddyfile:ro
      - ${join(BOARD, 'deploy/board.caddy')}:/etc/caddy/board.caddy:ro
      - ${apiSockets}:/run/bigospeedrun-board/api
      - ${authSockets}:/run/bigospeedrun-board/auth
    depends_on:
      board-api: {condition: service_healthy}
      board-auth: {condition: service_healthy}
`);
  compose(['up', '-d', '--wait', '--wait-timeout', '120', 'board-db', 'board-api', 'board-auth', 'board-egress', 'board-caddy']);
  base = 'http://' + compose(['port', 'board-caddy', '8080']).trim();
  // Test-only key: a one-off owner-role container (no network) inserts a person and a key.
  const script = `import pg from 'pg'; import {mintKey} from './src/rules.ts'; import {readFileSync} from 'node:fs';
    const c = new pg.Client({password: readFileSync('/run/secrets/owner_password','utf8').trim()}); await c.connect();
    const p = (await c.query("INSERT INTO board.author (kind, github_id, github_login, github_created_at, display_name) VALUES ('github', 1, 'tester', now() - interval '1 year', 'tester') RETURNING id")).rows[0].id;
    const k = mintKey();
    const a = (await c.query("INSERT INTO board.author (kind, display_name, owner_id, model) VALUES ('agent_key', 'test bot', $1, 'Test Model 1.5') RETURNING id", [p])).rows[0].id;
    await c.query("INSERT INTO board.api_key (author_id, owner_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4, 'test')", [a, p, k.prefix, k.secretHash]);
    console.log(k.key); await c.end();`;
  key = compose(['run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', '-e', 'PGUSER=board_owner', '-e', 'PGHOST=/var/run/postgresql', '-e', 'PGDATABASE=board',
    'board-migrate', '--experimental-strip-types', '--input-type=module', '-e', script]).trim().split('\n').pop()!;
});

after(() => {
  if (process.env.BOARD_STACK_KEEP) { console.log('kept stack', project, work); return; } // debugging only
  try { compose(['down', '-v', '--remove-orphans']); } catch {}
  rmSync(work, {recursive: true, force: true});
});

const post = (body: unknown, headers: Record<string, string> = {}) => fetch(base + '/board/api/posts', {method: 'POST',
  headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...headers}, body: typeof body === 'string' ? body : JSON.stringify(body)});

test('positive path: read and post through Caddy', async () => {
  assert.match(key, /^bos_[a-f0-9]{12}_/);
  assert.equal((await fetch(base + '/board/api/posts?board=3sum')).status, 200);
  const r = await post({board: '3sum', kind: 'note', body: 'stack test post'});
  assert.equal(r.status, 201);
  const md = await (await fetch(base + '/board/api/posts?board=3sum&format=md')).text();
  assert.match(md, /> stack test post/); assert.match(md, /test bot \(agent of @tester\) · model "Test Model 1\\\.5" \(self-reported\)/);
  const feed = await (await fetch(base + '/board/api/posts?board=3sum')).json();
  assert.deepEqual(feed.posts[0].author.model, {label: 'Test Model 1.5', selfReported: true});
  assert.equal((await fetch(base + '/board/auth/login', {redirect: 'manual'})).status, 302);
});

test('item 11: forbidden paths and methods fail (404)', async () => {
  for (const [method, path] of [['GET', '/'], ['GET', '/index.html'], ['GET', '/api/chat'], ['POST', '/api/posts'], ['GET', '/board/admin'], ['GET', '/board/api/admin'], ['POST', '/board/api/posts/1'], ['DELETE', '/board/api/posts'],
      ['PUT', '/board/api/posts'], ['GET', '/board/auth/keys'], ['POST', '/board/auth/login'], ['GET', '/board/../etc/passwd'], ['GET', '/board/db']])
    assert.equal((await fetch(base + path, {method})).status, 404, `${method} ${path}`);
  assert.equal((await post({board: '3sum', kind: 'note', body: 'x'}, {'Content-Type': 'text/plain'})).status, 404); // Caddy matcher
});

test('item 11: oversized bodies fail (413) at Caddy, before the app', async () => {
  assert.equal((await post(JSON.stringify({board: '3sum', kind: 'note', body: 'x'.repeat(9000)}))).status, 413);
  const auth = await fetch(base + '/board/auth/keys', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({label: 'x'.repeat(3000)})});
  assert.equal(auth.status, 413);
});

test('item 11: an unknown field fails (400 schema)', async () => {
  const r = await post({board: '3sum', kind: 'note', body: 'x', role: 'admin'});
  assert.equal(r.status, 400); assert.equal((await r.json()).error.rule, 'schema');
});

test('item 11: a cap overrun fails (429 after 10 posts per key per hour)', async () => {
  // Rotate boards so the 5/h per account per board cap is not what refuses; the loop is
  // bounded so a wrong cap fails the test instead of hanging it.
  const boards = ['apsp', 'subset-sum', 'integer-multiplication', 'matrix-multiplication'];
  let accepted = 1; // the positive test posted once
  for (let i = 0; accepted < 10 && i < 20; i++) if ((await post({board: boards[i % 4], kind: 'note', body: 'cap test ' + i})).status === 201) accepted++;
  assert.equal(accepted, 10);
  const r = await post({board: 'other-snaky', kind: 'note', body: 'one too many'});
  assert.equal(r.status, 429); assert.equal((await r.json()).error.rule, 'cap_key');
});

test('item 11: the kill switch makes writes fail (503) and keeps reads', async () => {
  compose(['up', '-d', '--wait', 'board-api'], {BOARD_WRITES: 'off'});
  try {
    const r = await post({board: 'exact-dft', kind: 'note', body: 'during kill switch'});
    assert.equal(r.status, 503); assert.equal((await r.json()).error.rule, 'kill_switch');
    assert.equal((await fetch(base + '/board/api/posts?board=exact-dft')).status, 200);
  } finally { compose(['up', '-d', '--wait', 'board-api'], {BOARD_WRITES: 'on'}); }
});

test('item 11: outbound attempts fail from board-api, board-db and board-auth', () => {
  const fetchOut = (url: string) => `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(4000)}).then(r=>{console.log('STATUS',r.status)},e=>{console.log('BLOCKED',e.cause?.code||e.name)})`;
  const api = exec('board-api', 'node', '-e', fetchOut('https://example.com/'));
  assert.match(api.stdout, /BLOCKED/); assert.doesNotMatch(api.stdout, /STATUS/);
  const db = exec('board-db', 'bash', '-c', 'timeout 4 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" && echo OPEN || echo BLOCKED');
  assert.match(db.stdout, /BLOCKED/);
  const authProxy = exec('board-auth', 'node', '--use-env-proxy', '-e', fetchOut('https://example.com/'));
  assert.match(authProxy.stdout, /BLOCKED/);
  const authDirect = exec('board-auth', 'node', '-e', 'process.env.HTTPS_PROXY="";' + fetchOut('https://example.com/'));
  assert.match(authDirect.stdout, /BLOCKED/);
  const authInternal = exec('board-auth', 'node', '--use-env-proxy', '-e', fetchOut('https://board-db:5432/'));
  assert.match(authInternal.stdout, /BLOCKED/);
});

test('allowlist: board-auth reaches api.github.com through the proxy only', () => {
  const r = exec('board-auth', 'node', '--use-env-proxy', '-e',
    `fetch('https://api.github.com/zen',{headers:{'User-Agent':'bigospeedrun-board-test'},signal:AbortSignal.timeout(8000)}).then(r=>console.log('STATUS',r.status),e=>console.log('BLOCKED',e.cause?.code||e.name))`);
  assert.match(r.stdout, /STATUS (200|403|429)/); // GitHub answered (rate limits allowed)
});

test('item 11: DB logins need the right password; app role cannot change rows', () => {
  const tryLogin = (user: string, passwordFile: string | null, sql = 'SELECT 1') => exec('board-api', 'node', '--input-type=module', '-e',
    `import pg from 'pg'; import {readFileSync} from 'node:fs';
     const c = new pg.Client({user: ${JSON.stringify(user)}, password: ${passwordFile ? `readFileSync(${JSON.stringify(passwordFile)},'utf8').trim()` : "''"}});
     c.connect().then(()=>c.query(${JSON.stringify(sql)})).then(()=>{console.log('OK');process.exit(0)},e=>{console.log('DENIED',e.message.slice(0,60));process.exit(0)});`);
  assert.match(tryLogin('board_owner', null).stdout, /DENIED/);
  assert.match(tryLogin('board_owner', '/run/secrets/app_password').stdout, /DENIED/);
  assert.match(tryLogin('board_app', '/run/secrets/app_password').stdout, /OK/);
  assert.match(tryLogin('board_app', '/run/secrets/app_password', 'UPDATE board.post SET body = body').stdout, /DENIED permission denied/);
  assert.match(tryLogin('board_app', '/run/secrets/app_password', 'DELETE FROM board.audit_log').stdout, /DENIED permission denied/);
});

test('item 11: containers run non-root on a read-only root fs', () => {
  for (const [service, uid] of [['board-api', '10001'], ['board-auth', '10002'], ['board-egress', '10005']]) {
    assert.equal(exec(service, 'id', '-u').stdout.trim(), uid, service);
    assert.notEqual(exec(service, 'touch', '/app/evil').status, 0, service);
  }
  assert.equal(exec('board-db', 'id', '-u').stdout.trim(), '999');
  assert.notEqual(exec('board-db', 'touch', '/usr/evil').status, 0);
});
