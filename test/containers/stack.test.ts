// Playbook item 11 negative tests on the real stack: the board image, the compose
// fragment and board.caddy in a test Caddy container, all on this machine (no VPS).
// Every request goes Caddy -> unix socket -> service -> Postgres socket.
// Must fail: forbidden path, oversized body, unknown field, cap overrun, kill switch,
// outbound attempt (api, db, auth direct, auth via proxy to a non-GitHub host),
// a passwordless or wrong-role DB login, and writes to the read-only root fs.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync} from 'node:fs';
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
// The group of each secret file in production: the only group (with root) that can read it.
const SECRET_GROUPS: Record<string, number> = {owner_password: 999, owner_password_node: 10003, dump_password: 10003, app_password: 10001,
  auth_password: 10002, github_client_secret: 10002, state_secret: 10002, admin_password: 10004};
const env = {...process.env, BOARD_IMAGE: IMAGE, BOARD_SECRETS_DIR: secrets, BOARD_API_SOCKET_DIR: apiSockets, BOARD_AUTH_SOCKET_DIR: authSockets, BOARD_WRITES: 'on', BOARD_SOCKET_GID: '10001'};
const files = ['-f', join(BOARD, 'deploy/compose.board.yml'), '-f', join(work, 'test.override.yml')];
const compose = (args: string[], extraEnv: Record<string, string> = {}) => {
  const r = spawnSync('docker', ['compose', '-p', project, ...files, ...args], {env: {...env, ...extraEnv}, encoding: 'utf8'});
  if (r.status !== 0) throw new Error(`docker compose ${args[0]} failed: ${(r.stderr || '').slice(-1500)}`);
  return r.stdout;
};
const exec = (service: string, ...cmd: string[]) =>
  spawnSync('docker', ['compose', '-p', project, ...files, 'exec', '-T', service, ...cmd], {env, encoding: 'utf8'});
let base = '', gated = '', key = '';

before(async () => {
  execFileSync('docker', ['build', '-q', '-f', join(BOARD, 'Dockerfile'), '-t', IMAGE, BOARD], {stdio: 'ignore'});
  mkdirSync(secrets); mkdirSync(apiSockets); mkdirSync(authSockets);
  for (const dir of [apiSockets, authSockets]) chmodSync(dir, 0o777); // test only; production: group wg-caddy, mode 2770
  const owner = randomBytes(24).toString('base64url');
  for (const [name, value] of Object.entries({owner_password: owner, owner_password_node: owner, app_password: randomBytes(24).toString('base64url'),
      auth_password: randomBytes(24).toString('base64url'), admin_password: randomBytes(24).toString('base64url'), dump_password: randomBytes(24).toString('base64url'),
      github_client_secret: randomBytes(20).toString('hex'), state_secret: randomBytes(32).toString('base64url')}))
    writeFileSync(join(secrets, name), value + '\n');
  // The production owners and modes (compose.board.yml header, plan E1): root, 0440, one
  // group each. A service that reads a secret its groups do not cover fails here, as on the
  // VPS. chown needs root, so a throwaway container sets them; the work dir is ours, so the
  // files can still be removed after the test.
  execFileSync('docker', ['run', '--rm', '--network', 'none', '--user', '0:0', '-v', `${secrets}:/s`, '--entrypoint', 'sh', CADDY, '-c',
    Object.entries(SECRET_GROUPS).map(([name, gid]) => `chown 0:${gid} /s/${name} && chmod 0440 /s/${name}`).join(' && ')], {stdio: 'ignore'});
  // Same shape as production (board.bigospeedrun.com { import board.caddy }), on plain :8080.
  // The cloudflare_only snippet has the shape of the shared one on the VPS
  // (/etc/wg-caddy/cloudflare-ips.caddy); only the trusted ranges differ. board-caddy trusts
  // the private ranges (the test peer), so requests pass; board-caddy-gated trusts only
  // TEST-NET-1 (192.0.2.0/24), so the test peer is not Cloudflare and must be aborted.
  const caddyfile = (trusted: string) => `{\n\tadmin off\n\tauto_https off\n\tstorage file_system /tmp/caddy\n}\n` +
    `(cloudflare_only) {\n\t@not_cloudflare not remote_ip ${trusted}\n\tabort @not_cloudflare\n}\n:8080 {\n\timport /etc/caddy/board.caddy\n}\n`;
  writeFileSync(join(work, 'Caddyfile'), caddyfile('private_ranges'));
  writeFileSync(join(work, 'Caddyfile.gated'), caddyfile('192.0.2.0/24'));
  // Test-only fronts: Caddy with the production board.caddy, published on random local ports.
  const front = (name: string, file: string) => `  ${name}:
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
      - ${join(work, file)}:/etc/caddy/Caddyfile:ro
      - ${join(BOARD, 'deploy/board.caddy')}:/etc/caddy/board.caddy:ro
      - ${apiSockets}:/run/bigospeedrun-board/api
      - ${authSockets}:/run/bigospeedrun-board/auth
    depends_on:
      board-api: {condition: service_healthy}
      board-auth: {condition: service_healthy}
`;
  writeFileSync(join(work, 'test.override.yml'), 'services:\n' + front('board-caddy', 'Caddyfile') + front('board-caddy-gated', 'Caddyfile.gated'));
  compose(['up', '-d', '--wait', '--wait-timeout', '120', 'board-db', 'board-api', 'board-auth', 'board-egress', 'board-caddy', 'board-caddy-gated']);
  base = 'http://' + compose(['port', 'board-caddy', '8080']).trim();
  gated = 'http://' + compose(['port', 'board-caddy-gated', '8080']).trim();
  // Test-only key: a one-off owner-role container (no network) inserts a person and a key.
  const script = `import pg from 'pg'; import {mintKey} from './src/rules.ts'; import {readFileSync} from 'node:fs';
    const c = new pg.Client({password: readFileSync('/run/secrets/owner_password','utf8').trim()}); await c.connect();
    const p = (await c.query("INSERT INTO board.author (kind, github_id, github_login, github_created_at, display_name) VALUES ('github', 1, 'tester', now() - interval '1 year', 'tester') RETURNING id")).rows[0].id;
    const k = mintKey();
    const a = (await c.query("INSERT INTO board.author (kind, display_name, owner_id) VALUES ('agent_key', 'test bot', $1) RETURNING id", [p])).rows[0].id;
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

const post = (body: unknown, headers: Record<string, string> = {}) => fetch(base + '/api/posts', {method: 'POST',
  headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...headers}, body: typeof body === 'string' ? body : JSON.stringify(body)});

test('secrets have the production owners and modes, and every service reads the ones it mounts', () => {
  for (const [name, gid] of Object.entries(SECRET_GROUPS)) {
    const st = statSync(join(secrets, name));
    assert.deepEqual([st.uid, st.gid, st.mode & 0o777], [0, gid, 0o440], name);
  }
  // board-migrate ran (the stack is up, which needs it to finish); the long-running services
  // read their own files again here.
  for (const [service, files] of [['board-api', ['app_password']], ['board-auth', ['auth_password', 'github_client_secret', 'state_secret']]] as const)
    for (const file of files) {
      const r = exec(service, 'node', '-e', `require('fs').readFileSync('/run/secrets/${file}')`);
      assert.equal(r.status, 0, `${service} cannot read ${file}: ${r.stderr}`);
    }
});

test('positive path: read and post through Caddy', async () => {
  assert.match(key, /^bos_[a-f0-9]{12}_/);
  assert.equal((await fetch(base + '/api/posts?board=3sum')).status, 200);
  const r = await post({board: '3sum', body: 'stack test post', model: 'Test Model 1.5'});
  assert.equal(r.status, 201);
  const md = await (await fetch(base + '/api/posts?board=3sum&format=md')).text();
  assert.match(md, /> stack test post/); assert.match(md, /test bot \(agent of @tester\) · model "Test Model 1\\\.5" \(self-reported\)/);
  const feed = await (await fetch(base + '/api/posts?board=3sum')).json();
  assert.deepEqual(feed.posts[0].model, {label: 'Test Model 1.5', selfReported: true});   // the post's own model (migration 0006)
  assert.equal('kind' in feed.posts[0], false);   // posts have no category (Nil, 2026-10-15)
  assert.equal((await post({board: '3sum', kind: 'note', body: 'with a kind'})).status, 400);
  assert.equal((await post({board: '3sum', body: 'with links', links: ['https://a.b/c']})).status, 400);   // links live in the body
  assert.equal((await fetch(base + '/auth/login', {redirect: 'manual'})).status, 302);
});

test('pages through Caddy: the list at /, a board, an asset; pages are read-only; no /board/ paths', async () => {
  const index = await fetch(base + '/', {redirect: 'manual'});
  assert.equal(index.status, 200); assert.match(await index.text(), /<a href="\/3sum">3SUM<\/a>/);
  const board = await fetch(base + '/3sum');
  assert.equal(board.status, 200); assert.match(board.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const css = await fetch(base + '/assets/board.css');
  assert.equal(css.status, 200); assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
  for (const [method, path] of [['POST', '/3sum'], ['PUT', '/'], ['POST', '/assets/board.css'], ['GET', '/3sum/x'], ['GET', '/BAD'],
      ['GET', '/api'], ['GET', '/auth'], ['GET', '/assets'],
      // The old paths under /board/ are gone (no redirects: the move was before the launch).
      ['GET', '/board/'], ['GET', '/board/3sum'], ['GET', '/board/api/posts?board=3sum'], ['GET', '/board/auth/login'], ['GET', '/board/assets/board.css']])
    assert.equal((await fetch(base + path, {method})).status, 404, `${method} ${path}`);
});

test('not found through Caddy: an unknown path and /board/3sum get the board 404 page; other methods a bare 404', async () => {
  for (const path of ['/board/3sum', '/no/such/path', '/wp-login.php', '/auth/nope', '/auth/keys', '/no-such-board']) {
    const r = await fetch(base + path);
    assert.equal(r.status, 404, path);
    assert.match(r.headers.get('content-type') ?? '', /^text\/html/, path);
    const text = await r.text();
    assert.match(text, /<h1>Not found<\/h1>/, path); assert.match(text, /<a href="\/">Go to the boards<\/a>/, path);
    assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'/, path);
  }
  for (const [method, path] of [['POST', '/no/such/path'], ['PUT', '/board/3sum'], ['DELETE', '/x']]) {
    const r = await fetch(base + path, {method});
    assert.equal(r.status, 404, `${method} ${path}`); assert.equal(await r.text(), '', `${method} ${path}`);
  }
});

test('launch basics through Caddy: robots.txt, sitemap.xml, manifest and icons; tags and the GA CSP on the pages', async () => {
  const robots = await fetch(base + '/robots.txt');
  assert.equal(robots.status, 200); assert.match(await robots.text(), /^User-agent: \*\nAllow: \/\nDisallow: \/auth\/\nDisallow: \/api\//);
  const map = await (await fetch(base + '/sitemap.xml')).text();
  assert.match(map, /<loc>https:\/\/board\.bigospeedrun\.com\/3sum<\/loc>/);
  for (const path of ['/site.webmanifest', '/favicon.ico', '/apple-touch-icon.png']) assert.equal((await fetch(base + path)).status, 200, path);
  const board = await fetch(base + '/3sum');
  const html = await board.text();
  assert.match(html, /<link rel="canonical" href="https:\/\/board\.bigospeedrun\.com\/3sum">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.doesNotMatch(html, /noindex/);
  assert.match(board.headers.get('content-security-policy') ?? '', /script-src 'self' https:\/\/\*\.googletagmanager\.com;/);
  const auth = await fetch(base + '/auth/account');
  assert.doesNotMatch(auth.headers.get('content-security-policy') ?? '', /google/);
  assert.match(await auth.text(), /<meta name="robots" content="noindex">/);
});

test('Cloudflare gate: a peer outside the trusted ranges is aborted on every route; a trusted peer passes', async () => {
  const routes: [string, string, RequestInit?][] = [['GET', '/'], ['GET', '/3sum'], ['GET', '/assets/board.css'],
    ['GET', '/api/posts?board=3sum'], ['GET', '/auth/login'], ['GET', '/auth/account'], ['GET', '/nothing'],
    ['POST', '/api/posts', {headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key}, body: JSON.stringify({board: '3sum', body: 'gate'})}],
    ['POST', '/auth/logout', {headers: {Origin: 'https://board.bigospeedrun.com'}}]];
  for (const [method, path, init] of routes) {
    // abort closes the connection with no response, so fetch rejects (curl: exit 52 / 92).
    await assert.rejects(fetch(gated + path, {method, redirect: 'manual', ...init}), `${method} ${path} must be aborted`);
  }
  // The front that trusts the test peer serves them (every other test uses it too).
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/3sum')).status, 200);
});

test('item 11: forbidden paths and methods fail (404)', async () => {
  for (const [method, path] of [['GET', '/index.html'], ['GET', '/api/chat'], ['POST', '/api/posts'], ['GET', '/admin'], ['GET', '/api/admin'], ['POST', '/api/posts/1'], ['DELETE', '/api/posts'],
      ['PUT', '/api/posts'], ['GET', '/auth/keys'], ['POST', '/auth/login'], ['GET', '/../etc/passwd'], ['GET', '/db'], ['GET', '/.env']])
    assert.equal((await fetch(base + path, {method})).status, 404, `${method} ${path}`);
  assert.equal((await post({board: '3sum', body: 'x'}, {'Content-Type': 'text/plain'})).status, 404); // Caddy matcher
});

test('item 11: oversized bodies fail (413) at Caddy, before the app', async () => {
  assert.equal((await post(JSON.stringify({board: '3sum', body: 'x'.repeat(9000)}))).status, 413);
  const auth = await fetch(base + '/auth/keys', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({label: 'x'.repeat(3000)})});
  assert.equal(auth.status, 413);
});

test('item 11: an unknown field fails (400 schema)', async () => {
  const r = await post({board: '3sum', body: 'x', role: 'admin'});
  assert.equal(r.status, 400); assert.equal((await r.json()).error.rule, 'schema');
});

test('item 11: a cap overrun fails (429 after 10 posts per key per hour)', async () => {
  // Rotate boards so the 5/h per account per board cap is not what refuses; the loop is
  // bounded so a wrong cap fails the test instead of hanging it.
  const boards = ['apsp', 'subset-sum', 'integer-multiplication', 'matrix-multiplication'];
  let accepted = 1; // the positive test posted once
  for (let i = 0; accepted < 10 && i < 20; i++) if ((await post({board: boards[i % 4], body: 'cap test ' + i})).status === 201) accepted++;
  assert.equal(accepted, 10);
  const r = await post({board: 'other-snaky', body: 'one too many'});
  assert.equal(r.status, 429); assert.equal((await r.json()).error.rule, 'cap_key');
});

test('item 11: the kill switch makes writes fail (503) and keeps reads', async () => {
  compose(['up', '-d', '--wait', 'board-api'], {BOARD_WRITES: 'off'});
  try {
    const r = await post({board: 'exact-dft', body: 'during kill switch'});
    assert.equal(r.status, 503); assert.equal((await r.json()).error.rule, 'kill_switch');
    assert.equal((await fetch(base + '/api/posts?board=exact-dft')).status, 200);
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

test('agent sign-in through Caddy: JSON only, 2 KiB cap, GitHub reached through the proxy, per-IP limit not bypassed by X-Forwarded-For', async () => {
  const agent = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + '/auth/agent/' + path,
    {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: typeof body === 'string' ? body : JSON.stringify(body)});
  const ch = await agent('challenge', {github_login: 'stack-user', agent_name: 'stack agent'});
  assert.equal(ch.status, 201);
  const c = await ch.json();
  assert.match(c.filename, /^bos-board-[a-f0-9]{16}\.txt$/);
  // Caddy refuses what the app would: not JSON (404 at the matcher), another method, too big.
  assert.equal((await agent('challenge', 'github_login=x', {'Content-Type': 'application/x-www-form-urlencoded'})).status, 404);
  assert.equal((await fetch(base + '/auth/agent/challenge')).status, 404);
  assert.equal((await fetch(base + '/auth/agent/other', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})).status, 404);
  assert.equal((await agent('verify', {challenge_id: c.challenge_id, gist_id: 'f'.repeat(32), pad: 'x'.repeat(3000)})).status, 413);
  // board-auth reads gists from api.github.com through the egress proxy (a missing gist: 404).
  const direct = exec('board-auth', 'node', '--use-env-proxy', '-e',
    `fetch('https://api.github.com/gists/${'f'.repeat(32)}',{headers:{'User-Agent':'bigospeedrun-board-test'},signal:AbortSignal.timeout(8000)}).then(r=>console.log('STATUS',r.status),e=>console.log('BLOCKED',e.cause?.code||e.name))`);
  assert.match(direct.stdout, /STATUS (404|403|429)/);
  // The test stack's client secret is random, so GitHub refuses the app login (401) and the
  // verify ends as a GitHub error; the challenge is used either way.
  const v = await agent('verify', {challenge_id: c.challenge_id, gist_id: 'f'.repeat(32)});
  assert.equal(v.status, 502); assert.equal((await v.json()).error.rule, 'github');
  assert.equal((await agent('verify', {challenge_id: c.challenge_id, gist_id: 'f'.repeat(32)})).status, 409);
  // Caddy replaces X-Forwarded-For with the peer address: a new value per request does not
  // get a new per-IP allowance (10 challenges per hour; one is used above).
  const statuses: number[] = [];
  for (let i = 0; i < 10; i++)
    statuses.push((await agent('challenge', {github_login: 'stack' + i, agent_name: 'x'}, {'X-Forwarded-For': '198.51.100.' + i})).status);
  assert.deepEqual(statuses, [...Array(9).fill(201), 429]);
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
