// deploy/auto-deploy.sh against a fake docker, a fake health probe, a fake pull marker, a
// fake socket check and a stub registry plus GitHub API. Nothing here touches a real registry, GitHub or Docker.
// The cases follow the site's src/lib/self-host-deploy.test.ts, plus the migration guard.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync, cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, type Server} from 'node:http';
import {spawn} from 'node:child_process';
import type {AddressInfo} from 'node:net';

const script = new URL('../../deploy/auto-deploy.sh', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'board-deploy-'));
const root = join(dir, 'root'), envDir = join(dir, 'etc'), fake = join(dir, 'fake'), units = join(dir, 'units'), marker = join(dir, 'last-pull.json');
for (const path of [root, fake, units, join(fake, 'labels'), join(fake, 'images')]) mkdirSync(path, {recursive: true});
mkdirSync(envDir, {mode: 0o700});
const envLines = 'BOARD_IMAGE_REPO=ghcr.io/bigospeedrun/board\nBOARD_GITHUB_REPO=bigospeedrun/board\nBOARD_IMAGE_WORKFLOW=image.yml\n';
writeFileSync(join(envDir, 'board-auto-deploy.env'), envLines, {mode: 0o600});
const digest = (n: number) => 'sha256:' + String(n).repeat(64).slice(0, 64);
const commit = (n: number) => String(n).repeat(40).slice(0, 40);
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) writeFileSync(join(fake, 'labels', digest(n)), commit(n));
const rehearsalBad = 'sha256:' + 'a'.repeat(64);
writeFileSync(join(fake, 'labels', rehearsalBad), 'a'.repeat(40));
// Each fake image is a directory fake/images/<digest>/db/migrations (fake/images/base for
// any other digest); `docker run` runs the tick's own list command in it.
const base5: Record<string, string> = {'0001_schema.sql': '-- schema\nCREATE SCHEMA x;\n', '0005_dump_role.sql': '-- backup role\n'};
const imageDir = (d: string) => join(fake, 'images', d);
function image(n: number | string, files: Record<string, string>, from?: number) {
  const d = typeof n === 'number' ? digest(n) : n, dir = join(imageDir(d), 'db/migrations');
  rmSync(imageDir(d), {recursive: true, force: true});
  if (from !== undefined) cpSync(imageDir(digest(from)), imageDir(d), {recursive: true});
  mkdirSync(dir, {recursive: true});
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}
image('base', base5);
writeFileSync(join(root, 'compose.board.yml'), 'services: {}\n');
writeFileSync(join(root, 'release.env'), `BOARD_SOCKET_GID=64543\nBOARD_WRITES=off\nBOARD_IMAGE=ghcr.io/bigospeedrun/board@${digest(1)}\n`);
writeFileSync(join(root, 'release.commit'), commit(1) + '\n');
writeFileSync(join(fake, 'running'), digest(1));
writeFileSync(join(fake, 'unhealthy'), '');

// docker: pull and inspect read the fake labels; `run` prints an image's migration list
// (fake/migrations/<digest>, else the base list); `compose up` starts whatever release.env
// names and fails for an unhealthy digest. The probe prints what runs, if it is healthy.
writeFileSync(join(fake, 'docker'), `#!/usr/bin/env bash
fake=${fake}
case $1 in
pull) grep -qx "\${3##*@}" "$fake/pull-fail" 2>/dev/null && exit 1; exit 0 ;;
image) ref=\${@: -1}; cat "$fake/labels/\${ref##*@}" ;;
run)
  [[ -e $fake/run-fail ]] && exit 1
  while [[ $1 != --entrypoint ]]; do shift; done
  entrypoint=$2 ref=$3; shift 3
  dir=$fake/images/\${ref##*@}; [[ -d $dir ]] || dir=$fake/images/base
  cd "$dir" && exec "$entrypoint" "$@" ;;
compose)
  for ((i=1; i<=$#; i++)); do [[ \${!i} == --env-file ]] && { j=$((i+1)); env_file=\${!j}; }; done
  d=$(sed -n 's/^BOARD_IMAGE=.*@//p' "$env_file"); echo "$d" > "$fake/running"
  grep -qx "$d" "$fake/unhealthy" && exit 1; exit 0 ;;
esac
`, {mode: 0o755});
writeFileSync(join(fake, 'probe'), `#!/usr/bin/env bash
d=$(cat ${fake}/running); grep -qx "$d" ${fake}/unhealthy && exit 1; echo "$d"
`, {mode: 0o755});
// The socket script fails while fake/socket-bad exists (a wg-caddy gid mismatch), and
// reports a repair while fake/socket-fixed exists, as socket-dirs.sh does.
writeFileSync(join(fake, 'socket-dirs'), `#!/usr/bin/env bash
[[ ! -e ${fake}/socket-bad ]] || exit 1
[[ ! -e ${fake}/socket-fixed ]] || printf 'fixed /run/bigospeedrun-board/api: was 0:0 2770, now 0:64543 2770\\nfixed /run/bigospeedrun-board/auth: was 0:0 2770, now 0:64543 2770\\n'
`, {mode: 0o755});
// What the dump program writes after a pull by the backup host.
const pulled = (when: Date) => writeFileSync(marker, JSON.stringify({snapshot_utc: when.toISOString().replace(/\.\d+Z$/, 'Z')}) + '\n');

let mainDigest = digest(1), runStatus = 'completed', apiFails = false, served = {ok: 0, notModified: 0};
let server: Server;
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (url.pathname === '/token') return res.end(JSON.stringify({token: 'stub'}));
    if (url.pathname === '/v2/bigospeedrun/board/manifests/main') { res.writeHead(200, {'Docker-Content-Digest': mainDigest}); return res.end(); }
    if (url.pathname === '/v2/bigospeedrun/board/manifests/rehearsal-bad') { res.writeHead(200, {'Docker-Content-Digest': rehearsalBad}); return res.end(); }
    if (url.pathname === '/repos/bigospeedrun/board/actions/workflows/image.yml/runs') {
      if (apiFails) { res.writeHead(500); return res.end(); }
      const etag = `W/"${runStatus}"`;
      if (req.headers['if-none-match'] === etag) { served.notModified++; res.writeHead(304, {ETag: etag}); return res.end(); }
      served.ok++;
      res.writeHead(200, {ETag: etag, 'Content-Type': 'application/json'});
      return res.end(JSON.stringify({workflow_runs: [{status: runStatus}]}));
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
});
after(() => { server.close(); rmSync(dir, {recursive: true, force: true}); });

const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// spawnSync would block the stub server in this process, so the tick runs asynchronously.
function tick(): Promise<{status: Record<string, unknown>; output: string}> {
  return new Promise(done => {
    const child = spawn('bash', [script], {env: {PATH: process.env.PATH, BOARD_ROOT: root, BOARD_ENV_DIR: envDir, BOARD_UNIT_DIR: units,
      BOARD_DOCKER: join(fake, 'docker'), BOARD_PROBE: join(fake, 'probe'), BOARD_REGISTRY: base(), BOARD_GITHUB_API: base(),
      BOARD_PULL_MARKER: marker, BOARD_SOCKET_DIRS: join(fake, 'socket-dirs')}});
    let output = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    child.on('close', () => done({status: JSON.parse(readFileSync(join(root, 'auto-deploy/status.json'), 'utf8')), output}));
  });
}
const failed = () => existsSync(join(root, 'auto-deploy/failed')) ? readFileSync(join(root, 'auto-deploy/failed'), 'utf8').trim().split('\n') : [];
const running = () => readFileSync(join(fake, 'running'), 'utf8').trim();

test('status.json has exactly the Hosted Isomux fields, in order; an unchanged tag is up to date', async () => {
  const {status} = await tick();
  assert.deepEqual(Object.keys(status), ['tick_at', 'deployed', 'result', 'phase', 'target', 'stopped', 'held', 'waiting', 'waiting_since', 'tick_error_since', 'units', 'last_attempt']);
  assert.deepEqual(Object.keys(status.last_attempt as object), ['at', 'target', 'result']);
  assert.equal(status.result, 'up_to_date');
  assert.equal(status.deployed, commit(1));
  assert.equal(status.units, 'absent');
  await tick();
  assert.deepEqual(served, {ok: 1, notModified: 1});
});

test('a running image workflow is waiting; a new main digest with no new migration deploys at once', async () => {
  runStatus = 'in_progress';
  let {status} = await tick();
  assert.equal(status.result, 'waiting');
  assert.equal(status.waiting, true);
  runStatus = 'completed'; mainDigest = digest(2);
  ({status} = await tick());
  assert.equal(status.result, 'deployed');
  assert.equal(status.deployed, commit(2));
  // Only the image line changes: the socket gid and the kill switch stay.
  assert.equal(readFileSync(join(root, 'release.env'), 'utf8'), `BOARD_SOCKET_GID=64543\nBOARD_WRITES=off\nBOARD_IMAGE=ghcr.io/bigospeedrun/board@${digest(2)}\n`);
});

test('a new migration waits for an off-box pull that started after the target was first seen', async () => {
  pulled(new Date(Date.now() - 3_600_000));   // last night's pull is too old
  image(3, {...base5, '0006_more.sql': '-- more boards\n'});
  mainDigest = digest(3);
  let {status} = await tick();
  assert.equal(status.result, 'waiting');
  assert.equal(status.phase, 'backup');
  assert.equal(status.waiting, true);
  const since = String(status.waiting_since);
  assert.match(since, /^\d{4}-\d\d-\d\dT/);
  assert.equal(running(), digest(2));
  // The wait keeps its start time across ticks (the dead-man measures it).
  await new Promise(done => setTimeout(done, 1100));
  ({status} = await tick());
  assert.equal(status.result, 'waiting');
  assert.equal(status.waiting_since, since);
  pulled(new Date(Date.now() + 2000));
  ({status} = await tick());
  assert.equal(status.result, 'deployed');
  assert.equal(status.deployed, commit(3));
  assert.equal(status.waiting, false);
  assert.equal(existsSync(join(root, 'auto-deploy/backup-wanted')), false);
});

test('a migration marked -- manual stops until the operator allows that digest, then still waits for a pull', async () => {
  pulled(new Date(Date.now() - 3_600_000));
  image(4, {'0007_split.sql': '-- manual: split a table\nALTER TABLE x;\n'}, 3);
  mainDigest = digest(4);
  let {status} = await tick();
  assert.equal(status.result, 'manual_deploy_needed');
  assert.equal(status.phase, 'migrations');
  assert.equal(running(), digest(3));
  writeFileSync(join(root, 'auto-deploy/manual-ok'), digest(4) + '\n');
  ({status} = await tick());
  assert.equal(status.result, 'waiting');
  assert.equal(status.phase, 'backup');
  pulled(new Date(Date.now() + 2000));
  ({status} = await tick());
  assert.equal(status.result, 'deployed');
  assert.equal(status.deployed, commit(4));
});

test('socket directories are repaired by the tick, with one log line, and the tick goes on', async () => {
  writeFileSync(join(fake, 'socket-fixed'), '');
  const {status, output} = await tick();
  assert.equal(status.result, 'up_to_date');
  assert.equal(status.tick_error_since, null);
  assert.match(output, /socket directories repaired: fixed \/run\/bigospeedrun-board\/api: was 0:0 2770, now 0:64543 2770; fixed \/run\/bigospeedrun-board\/auth/);
  rmSync(join(fake, 'socket-fixed'));
  assert.doesNotMatch((await tick()).output, /repaired/);
});

test('a socket repair that fails (wg-caddy gid mismatch) deploys nothing', async () => {
  writeFileSync(join(fake, 'socket-bad'), '');
  mainDigest = digest(5);
  const {status} = await tick();
  assert.equal(status.result, 'tick_error');
  assert.equal(status.phase, 'sockets');
  assert.equal(running(), digest(4));
  rmSync(join(fake, 'socket-bad'));
});

test('the same migrations as the running image need no new pull', async () => {
  for (const n of [5, 6, 7]) {
    image(n, {}, 4);
    mainDigest = digest(n);
    assert.equal((await tick()).status.result, 'deployed');
  }
});

test('an unhealthy image rolls back by itself and is not tried again', async () => {
  image(8, {}, 7);
  writeFileSync(join(fake, 'unhealthy'), digest(8) + '\n');
  mainDigest = digest(8);
  let {status} = await tick();
  assert.equal(status.result, 'rolled_back');
  assert.equal(status.deployed, commit(7));
  assert.equal(running(), digest(7));
  assert.deepEqual(failed(), [digest(8)]);
  // A rollback with no new migration does not stop the deploys; release.env keeps its lines.
  assert.equal(status.stopped, false);
  assert.equal(readFileSync(join(root, 'release.env'), 'utf8'), `BOARD_SOCKET_GID=64543\nBOARD_WRITES=off\nBOARD_IMAGE=ghcr.io/bigospeedrun/board@${digest(7)}\n`);
  ({status} = await tick());
  assert.equal(status.result, 'failed_target');
});

test('API errors, hold, lock and bad config deploy nothing', async () => {
  apiFails = true;
  let {status} = await tick();
  assert.equal(status.result, 'tick_error');
  apiFails = false;
  writeFileSync(join(envDir, 'board-auto-deploy.hold'), '');
  ({status} = await tick());
  assert.equal(status.result, 'held'); assert.equal(status.held, true);
  rmSync(join(envDir, 'board-auto-deploy.hold'));
  const holder = spawn('flock', [join(root, 'deploy.lock'), 'sleep', '1']);
  const released = new Promise(done => holder.on('close', done));
  await new Promise(done => setTimeout(done, 300));
  ({status} = await tick());
  assert.equal(status.result, 'locked');
  await released;
  chmodSync(join(envDir, 'board-auto-deploy.env'), 0o644);
  ({status} = await tick());
  assert.equal(status.phase, 'config');
  chmodSync(join(envDir, 'board-auto-deploy.env'), 0o600);
});

test('a failed rollback stops every later tick until the marker is deleted', async () => {
  writeFileSync(join(fake, 'labels', digest(9)), commit(9));
  image(9, {}, 7);
  // A new digest whose image fails, and the previous one no longer runs healthy either.
  mainDigest = digest(9);
  writeFileSync(join(fake, 'unhealthy'), [digest(9), digest(7)].join('\n') + '\n');
  let {status} = await tick();
  assert.equal(status.result, 'rollback_failed');
  assert.equal(status.stopped, true);
  ({status} = await tick());
  assert.equal(status.result, 'stopped');
  assert.equal(status.phase, 'marker');
});

test('BOARD_TAG follows a rehearsal tag, and an unhealthy rehearsal rolls back', async () => {
  rmSync(join(root, 'auto-deploy/stopped'), {force: true});
  writeFileSync(join(fake, 'unhealthy'), rehearsalBad + '\n');
  writeFileSync(join(envDir, 'board-auto-deploy.env'), envLines + 'BOARD_TAG=rehearsal-bad\n', {mode: 0o600});
  const before = running();
  assert.equal((await tick()).status.result, 'rolled_back');
  assert.equal(running(), before);
  assert.ok(failed().includes(rehearsalBad));
  writeFileSync(join(envDir, 'board-auto-deploy.env'), envLines + 'BOARD_TAG=bad tag\n', {mode: 0o600});
  assert.equal((await tick()).status.phase, 'config');
});

const label = (n: number) => writeFileSync(join(fake, 'labels', digest(n)), commit(n));
const stamp = (when: Date) => when.toISOString().replace(/\.\d+Z$/, 'Z');
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const stateFile = (name: string) => join(root, 'auto-deploy', name);

test('-- manual is read strictly: a BOM, blank lines, no space, any case', async () => {
  writeFileSync(join(envDir, 'board-auto-deploy.env'), envLines, {mode: 0o600});
  writeFileSync(join(fake, 'unhealthy'), '');
  assert.equal(running(), digest(7));
  pulled(new Date(Date.now() - 3_600_000));
  const cases: [number, string, boolean][] = [
    [12, '\uFEFF-- manual: with a BOM\nALTER TABLE x;\n', true],
    [13, '\n   \n-- manual after blank lines\n', true],
    [14, '--manual\nALTER TABLE x;\n', true],
    [15, '-- MANUAL\n', true],
    [16, '\uFEFF\r\n\r\n--Manual\r\nALTER TABLE x;\r\n', true],
    [17, '-- manually tuned, not a marker\n', false],
    [18, 'SELECT 1; -- manual\n', false],
  ];
  for (const [n, text, manual] of cases) {
    label(n); image(n, {'0008_case.sql': text}, 7);
    mainDigest = digest(n);
    const {status} = await tick();
    assert.equal(status.result, manual ? 'manual_deploy_needed' : 'waiting', JSON.stringify(text));
    assert.equal(running(), digest(7));
  }
});

test('tick_error_since keeps its start while ticks fail, and a good tick clears it', async () => {
  label(19); image(19, {}, 7);
  mainDigest = digest(19);
  writeFileSync(join(fake, 'run-fail'), '');
  let {status} = await tick();
  assert.equal(status.result, 'tick_error');
  assert.equal(status.phase, 'migrations');
  const since = status.tick_error_since;
  assert.match(String(since), /^\d{4}-\d\d-\d\dT/);
  await sleep(1100);
  ({status} = await tick());
  assert.equal(status.result, 'tick_error');
  assert.equal(status.tick_error_since, since);
  rmSync(join(fake, 'run-fail'));
  ({status} = await tick());
  assert.equal(status.result, 'deployed');
  assert.equal(status.tick_error_since, null);
});

test('a pull from before a long hold does not count; an equal or malformed marker waits', async () => {
  label(20); image(20, {'0008_more.sql': '-- more boards\n'}, 19);
  mainDigest = digest(20);
  pulled(new Date(Date.now() - 3_600_000));
  let {status} = await tick();
  assert.equal(status.result, 'waiting');
  // The target was first seen 3 h ago, then a hold; the daily pull 2 h ago came after the
  // first sight but is more than 30 minutes old.
  const longAgo = stamp(new Date(Date.now() - 3 * 3_600_000));
  writeFileSync(stateFile('backup-wanted'), `${digest(20)}\n${longAgo}\n`);
  writeFileSync(join(envDir, 'board-auto-deploy.hold'), '');
  pulled(new Date(Date.now() - 2 * 3_600_000));
  assert.equal((await tick()).status.result, 'held');
  rmSync(join(envDir, 'board-auto-deploy.hold'));
  ({status} = await tick());
  assert.equal(status.result, 'waiting');
  assert.equal(status.phase, 'backup');
  assert.equal(status.waiting_since, longAgo);
  assert.equal(running(), digest(19));
  // A recent first sight: a marker equal to it, or malformed, still waits.
  const since = stamp(new Date(Date.now() - 60_000));
  writeFileSync(stateFile('backup-wanted'), `${digest(20)}\n${since}\n`);
  for (const text of [JSON.stringify({snapshot_utc: since}), 'not json', JSON.stringify({finished_utc: stamp(new Date())}),
    JSON.stringify({snapshot_utc: new Date().toISOString()}), JSON.stringify({snapshot_utc: stamp(new Date()).replace('T', ' ')})]) {
    writeFileSync(marker, text + '\n');
    ({status} = await tick());
    assert.equal(status.result, 'waiting', text);
    assert.equal(running(), digest(19));
  }
  writeFileSync(marker, JSON.stringify({snapshot_utc: stamp(new Date(Date.parse(since) + 1000))}) + '\n');
  ({status} = await tick());
  assert.equal(status.result, 'deployed');
  assert.equal(running(), digest(20));
});

test('the operator override releases only its own digest, once, with no pull', async () => {
  label(21); image(21, {'0009_x.sql': '-- x\n'}, 20);
  mainDigest = digest(21);
  pulled(new Date(Date.now() - 3_600_000));
  assert.equal((await tick()).status.result, 'waiting');
  writeFileSync(stateFile('backup-override'), digest(20) + '\n');
  assert.equal((await tick()).status.result, 'waiting');
  writeFileSync(stateFile('backup-override'), digest(21) + '\n');
  const {status, output} = await tick();
  assert.equal(status.result, 'deployed');
  assert.equal(status.waiting, false);
  assert.match(output, /OVERRIDE/);
  assert.equal(existsSync(stateFile('backup-override')), false);
  assert.equal(running(), digest(21));
});

test('a rollback of an image that added a migration stops the deploys; release.env keeps its lines', async () => {
  label(23); image(23, {'0010_y.sql': '-- y\n'}, 21);
  mainDigest = digest(23);
  writeFileSync(join(fake, 'unhealthy'), digest(23) + '\n');
  pulled(new Date(Date.now() + 2000));
  let {status} = await tick();
  assert.equal(status.result, 'rolled_back');
  assert.equal(status.stopped, true);
  assert.equal(running(), digest(21));
  assert.ok(failed().includes(digest(23)));
  assert.equal(readFileSync(join(root, 'release.env'), 'utf8'), `BOARD_SOCKET_GID=64543\nBOARD_WRITES=off\nBOARD_IMAGE=ghcr.io/bigospeedrun/board@${digest(21)}\n`);
  ({status} = await tick());
  assert.equal(status.result, 'stopped');
  assert.equal(status.phase, 'marker');
  rmSync(stateFile('stopped'));
});
