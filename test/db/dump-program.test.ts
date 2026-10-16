// deploy/backup/bos-board-backup-dump on a real Postgres 18.6 container that carries the
// compose labels the program looks for. The program runs with its own code; only the
// constants that name this test's container, password file, lock and age key change.
// Needs Docker and `age` (CI installs it; the test is skipped without it).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startDb, type TestDb} from './pg.ts';

const program = new URL('../../deploy/backup/bos-board-backup-dump', import.meta.url).pathname;
const hasAge = spawnSync('age', ['--version']).status === 0;
const project = 'bosdumptest' + randomBytes(3).toString('hex');
const work = mkdtempSync(join(tmpdir(), 'bos-dump-'));
let db: TestDb;
let recipient = '';

before(async () => {
  if (!hasAge) return;
  db = await startDb(['--label', `com.docker.compose.project=${project}`, '--label', 'com.docker.compose.service=board-db',
    '--health-cmd', 'pg_isready -h /var/run/postgresql -U board_owner -d board', '--health-interval', '1s', '--health-retries', '30']);
  for (let i = 0; i < 60; i++) {
    const health = spawnSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', db.container], {encoding: 'utf8'}).stdout.trim();
    if (health === 'healthy') break;
    await new Promise(r => setTimeout(r, 500));
  }
  const key = spawnSync('age-keygen', ['-o', join(work, 'identity.txt')], {encoding: 'utf8'});
  recipient = (key.stderr.match(/age1[0-9a-z]+/) ?? [''])[0];
  writeFileSync(join(work, 'dump_password'), db.passwords.board_dump + '\n', {mode: 0o600});
  const owner = await db.client('board_owner');
  await owner.query(`INSERT INTO board.audit_log (action) VALUES ('test.dump_program')`);
  await owner.end();
});
after(() => { db?.stop(); rmSync(work, {recursive: true, force: true}); });

// Run the program as a module with this test's constants, as root would run it on the VPS.
const marker = join(work, 'marker', 'last-pull.json');
function runProgram(password = join(work, 'dump_password'), sudoUser = 'bosbackup') {
  const driver = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader('dump', sys.argv[1])
spec = importlib.util.spec_from_loader('dump', loader); m = importlib.util.module_from_spec(spec); loader.exec_module(m)
m.COMPOSE_PROJECT, m.PASSWORD_FILE, m.LOCK_FILE, m.AGE_RECIPIENT, m.WORK_PARENT, m.DOCKER, m.AGE, m.PULL_MARKER = sys.argv[2:10]
sys.argv = sys.argv[:1]
m.main()`;
  return spawnSync('python3', ['-I', '-B', '-c', driver, program, project, password, join(work, 'lock'), recipient, work, 'docker', 'age', marker],
    {maxBuffer: 64 << 20, env: {...process.env, SUDO_USER: sudoUser}});
}

test('the dump program streams meta.json and an encrypted custom-format dump of the board', {skip: !hasAge && 'age is not installed'}, () => {
  const run = runProgram();
  assert.equal(run.status, 0, String(run.stderr));
  assert.doesNotMatch(String(run.stderr) + String(run.stdout.subarray(0, 4096)), new RegExp(db.passwords.board_dump));
  writeFileSync(join(work, 'stream.tar'), run.stdout);
  if (process.env.BOS_DUMP_KEEP) { writeFileSync(join(process.env.BOS_DUMP_KEEP, 'stream.tar'), run.stdout); writeFileSync(join(process.env.BOS_DUMP_KEEP, 'identity.txt'), readFileSync(join(work, 'identity.txt'))); } // debugging only
  assert.deepEqual(spawnSync('tar', ['-tf', join(work, 'stream.tar')], {encoding: 'utf8'}).stdout.trim().split('\n'), ['meta.json', 'dump.age']);
  assert.equal(spawnSync('tar', ['-xf', join(work, 'stream.tar'), '-C', work]).status, 0);
  const meta = JSON.parse(readFileSync(join(work, 'meta.json'), 'utf8'));
  assert.equal(meta.format, 'wallgame-backup-meta/1');
  assert.equal(meta.product, 'bigospeedrun-board');
  assert.equal(meta.source.compose_project, project);
  assert.equal(meta.source.compose_service, 'board-db');
  assert.equal(meta.source.database, 'board');
  assert.match(meta.source.pg_system_identifier, /^\d{10,20}$/);
  assert.match(meta.source.pg_server_version, /^18\./);
  assert.equal(meta.dump.role, 'board_dump');
  assert.equal(meta.encryption.recipient, recipient);
  assert.equal(meta.migrations, null);
  assert.equal(meta.row_counts['board_meta.migration'], 5);
  assert.equal(meta.row_counts['board.audit_log'], 1);
  assert.equal(meta.row_counts['board.board'] > 0, true);
  // The ciphertext decrypts with the matching identity to a pg_dump custom archive.
  const plain = spawnSync('age', ['-d', '-i', join(work, 'identity.txt'), join(work, 'dump.age')], {maxBuffer: 64 << 20});
  assert.equal(plain.status, 0);
  assert.equal(plain.stdout.subarray(0, 5).toString(), 'PGDMP');
  const list = spawnSync('docker', ['exec', '-i', db.container, 'pg_restore', '-l'], {input: plain.stdout, maxBuffer: 64 << 20, encoding: 'utf8'});
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /TABLE DATA board post /);
  assert.match(list.stdout, /TABLE DATA board_meta migration /);
  // A run by the bosbackup login leaves the pull marker that the deploy tick reads.
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).snapshot_utc, meta.snapshot_utc);
});

test('a run by another sudo user leaves no pull marker', {skip: !hasAge && 'age is not installed'}, () => {
  rmSync(marker, {force: true});
  const run = runProgram(join(work, 'dump_password'), 'wgadmin');
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(existsSync(marker), false);
});

test('a wrong dump password makes no dump', {skip: !hasAge && 'age is not installed'}, () => {
  writeFileSync(join(work, 'wrong_password'), 'wrong-password-0123456789abcdef\n', {mode: 0o600});
  const run = runProgram(join(work, 'wrong_password'));
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout.length, 0);
});
