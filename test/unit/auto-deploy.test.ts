// deploy/auto-deploy.sh against a fake docker, a fake health probe, a fake dump program and
// a stub registry plus GitHub API. Nothing here touches a real registry, GitHub or Docker.
// The cases follow the site's src/lib/self-host-deploy.test.ts, plus the migration guard.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, rmSync, statSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, type Server} from 'node:http';
import {spawn} from 'node:child_process';
import type {AddressInfo} from 'node:net';

const script = new URL('../../deploy/auto-deploy.sh', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'board-deploy-'));
const root = join(dir, 'root'), envDir = join(dir, 'etc'), fake = join(dir, 'fake'), units = join(dir, 'units'), backups = join(dir, 'backups');
for (const path of [root, fake, units, join(fake, 'labels'), join(fake, 'migrations')]) mkdirSync(path, {recursive: true});
mkdirSync(envDir, {mode: 0o700});
const envLines = 'BOARD_IMAGE_REPO=ghcr.io/bigospeedrun/board\nBOARD_GITHUB_REPO=bigospeedrun/board\nBOARD_IMAGE_WORKFLOW=image.yml\n';
writeFileSync(join(envDir, 'board-auto-deploy.env'), envLines, {mode: 0o600});
const digest = (n: number) => 'sha256:' + String(n).repeat(64).slice(0, 64);
const commit = (n: number) => String(n).repeat(40).slice(0, 40);
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) writeFileSync(join(fake, 'labels', digest(n)), commit(n));
const rehearsalBad = 'sha256:' + 'a'.repeat(64);
writeFileSync(join(fake, 'labels', rehearsalBad), 'a'.repeat(40));
const base5 = '0001_schema.sql\t-- schema\n0005_dump_role.sql\t-- backup role\n';
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
  for a in "$@"; do [[ $a == *@sha256:* ]] && d=\${a##*@}; done
  if [[ -f $fake/migrations/$d ]]; then cat "$fake/migrations/$d"; else printf '${base5.replace(/\t/g, '\\t').replace(/\n/g, '\\n')}'; fi ;;
compose)
  for ((i=1; i<=$#; i++)); do [[ \${!i} == --env-file ]] && { j=$((i+1)); env_file=\${!j}; }; done
  d=$(sed -n 's/^BOARD_IMAGE=.*@//p' "$env_file"); echo "$d" > "$fake/running"
  grep -qx "$d" "$fake/unhealthy" && exit 1; exit 0 ;;
esac
`, {mode: 0o755});
writeFileSync(join(fake, 'probe'), `#!/usr/bin/env bash
d=$(cat ${fake}/running); grep -qx "$d" ${fake}/unhealthy && exit 1; echo "$d"
`, {mode: 0o755});
// The dump program: a fixed stream, or a failure while fake/dump-fail exists.
writeFileSync(join(fake, 'dump'), `#!/usr/bin/env bash
[[ -e ${fake}/dump-fail ]] && { echo 'FAIL dump' >&2; exit 1; }
echo "dump at $(cat ${fake}/running)"
`, {mode: 0o755});

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
      BOARD_DUMP: join(fake, 'dump'), BOARD_BACKUP_DIR: backups}});
    let output = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    child.on('close', () => done({status: JSON.parse(readFileSync(join(root, 'auto-deploy/status.json'), 'utf8')), output}));
  });
}
const failed = () => existsSync(join(root, 'auto-deploy/failed')) ? readFileSync(join(root, 'auto-deploy/failed'), 'utf8').trim().split('\n') : [];
const dumps = () => existsSync(backups) ? readdirSync(backups).sort() : [];
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

test('a running image workflow is waiting; a new main digest with no new migration deploys without a dump', async () => {
  runStatus = 'in_progress';
  let {status} = await tick();
  assert.equal(status.result, 'waiting');
  assert.equal(status.waiting, true);
  runStatus = 'completed'; mainDigest = digest(2);
  ({status} = await tick());
  assert.equal(status.result, 'deployed');
  assert.equal(status.deployed, commit(2));
  assert.deepEqual(dumps(), []);
  // Only the image line changes: the socket gid and the kill switch stay.
  assert.equal(readFileSync(join(root, 'release.env'), 'utf8'), `BOARD_SOCKET_GID=64543\nBOARD_WRITES=off\nBOARD_IMAGE=ghcr.io/bigospeedrun/board@${digest(2)}\n`);
});

test('a new migration gets a dump first; a failed dump deploys nothing and is tried again', async () => {
  writeFileSync(join(fake, 'migrations', digest(3)), base5 + '0006_more.sql\t-- more boards\n');
  writeFileSync(join(fake, 'dump-fail'), '');
  mainDigest = digest(3);
  let {status} = await tick();
  assert.equal(status.result, 'tick_error');
  assert.equal(status.phase, 'backup');
  assert.match(String(status.tick_error_since), /^\d{4}-/);
  assert.equal(running(), digest(2));
  assert.deepEqual(dumps(), []);
  rmSync(join(fake, 'dump-fail'));
  ({status} = await tick());
  assert.equal(status.result, 'deployed');
  assert.equal(status.tick_error_since, null);
  assert.deepEqual(dumps(), [`pre-${commit(3)}.tar`]);
  // The dump was taken while the previous image still ran.
  assert.equal(readFileSync(join(backups, `pre-${commit(3)}.tar`), 'utf8'), `dump at ${digest(2)}\n`);
});

test('a migration marked -- manual stops until the operator allows that digest', async () => {
  writeFileSync(join(fake, 'migrations', digest(4)), base5 + '0006_more.sql\t-- more boards\n0007_split.sql\t-- manual: split a table\n');
  mainDigest = digest(4);
  let {status} = await tick();
  assert.equal(status.result, 'manual_deploy_needed');
  assert.equal(status.phase, 'migrations');
  assert.equal(running(), digest(3));
  writeFileSync(join(root, 'auto-deploy/manual-ok'), digest(4) + '\n');
  ({status} = await tick());
  assert.equal(status.result, 'deployed');
  assert.equal(status.deployed, commit(4));
});

test('only the newest three pre-migration dumps are kept', async () => {
  let list = base5 + '0006_more.sql\t-- more boards\n0007_split.sql\t-- manual: split a table\n';
  for (const n of [5, 6, 7]) {
    // Age the dumps that exist, so that the newest-first order does not depend on the clock.
    for (const name of dumps()) {
      const old = new Date(statSync(join(backups, name)).mtimeMs - 120_000);
      utimesSync(join(backups, name), old, old);
    }
    list += `00${n + 3}_step.sql\t-- step ${n}\n`;
    writeFileSync(join(fake, 'migrations', digest(n)), list);
    mainDigest = digest(n);
    assert.equal((await tick()).status.result, 'deployed');
  }
  assert.deepEqual(dumps(), [`pre-${commit(5)}.tar`, `pre-${commit(6)}.tar`, `pre-${commit(7)}.tar`]);
});

test('an unhealthy image rolls back by itself and is not tried again', async () => {
  writeFileSync(join(fake, 'migrations', digest(8)), readFileSync(join(fake, 'migrations', digest(7))));
  writeFileSync(join(fake, 'unhealthy'), digest(8) + '\n');
  mainDigest = digest(8);
  let {status} = await tick();
  assert.equal(status.result, 'rolled_back');
  assert.equal(status.deployed, commit(7));
  assert.equal(running(), digest(7));
  assert.deepEqual(failed(), [digest(8)]);
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
  writeFileSync(join(fake, 'migrations', digest(9)), readFileSync(join(fake, 'migrations', digest(7))));
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
