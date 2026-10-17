// deploy/backup/bos-board-backup-dump on a real Postgres 18.6 container that carries the
// compose labels the program looks for. The program runs with its own code; only the
// constants that name this test's container, password file, lock and age key change.
// Needs Docker and `age` (CI installs it; the test is skipped without it). For the bosbackup
// login the program waits after the stream for the backup host's acknowledgement (the
// ciphertext SHA-256) and writes the pull marker only on an exact match.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync} from 'node:fs';
import {randomBytes, createHash} from 'node:crypto';
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
// The SHA-256 of dump.age in a stream, as the backup host computes it after its checks.
function cipherSha(stream: Buffer) {
  writeFileSync(join(work, 'ack-stream.tar'), stream);
  return createHash('sha256').update(spawnSync('tar', ['-xOf', join(work, 'ack-stream.tar'), 'dump.age'], {maxBuffer: 64 << 20}).stdout).digest('hex');
}
// answer, once the stream has ended: 'ack' the right hash, a 'wrong' one, 'none' (end of
// input), or 'silent' (stdin stays open; the program's own ACK_SECONDS ends the wait).
type Answer = 'ack' | 'wrong' | 'none' | 'silent';
function runProgram(password = join(work, 'dump_password'), sudoUser = 'bosbackup', answer: Answer = 'ack', ackSeconds = 900):
  Promise<{status: number | null; stdout: Buffer; stderr: string}> {
  const driver = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader('dump', sys.argv[1])
spec = importlib.util.spec_from_loader('dump', loader); m = importlib.util.module_from_spec(spec); loader.exec_module(m)
m.COMPOSE_PROJECT, m.PASSWORD_FILE, m.LOCK_FILE, m.AGE_RECIPIENT, m.WORK_PARENT, m.DOCKER, m.AGE, m.PULL_MARKER = sys.argv[2:10]
m.ACK_SECONDS = float(sys.argv[10])
sys.argv = sys.argv[:1]
m.main()`;
  return new Promise(done => {
    const child = spawn('python3', ['-I', '-B', '-c', driver, program, project, password, join(work, 'lock'), recipient, work, 'docker', 'age', marker, String(ackSeconds)],
      {env: {...process.env, SUDO_USER: sudoUser}});
    const out: Buffer[] = [];
    let stderr = '';
    child.stdin.on('error', () => {});   // an answer to a program that already ended
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => stderr += chunk);
    child.stdout.on('end', () => {
      if (answer === 'ack') child.stdin.end(cipherSha(Buffer.concat(out)) + '\n');
      else if (answer === 'wrong') child.stdin.end('0'.repeat(64) + '\n');
      else if (answer === 'none') child.stdin.end();
    });
    child.on('close', status => { child.stdin.destroy(); done({status, stdout: Buffer.concat(out), stderr}); });
  });
}

test('the dump program streams meta.json and an encrypted custom-format dump of the board', {skip: !hasAge && 'age is not installed'}, async () => {
  rmSync(marker, {force: true});
  const run = await runProgram();
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
  // One row per migration file; the hourly board sync adds files.
  assert.equal(meta.row_counts['board_meta.migration'], readdirSync(new URL('../../db/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).length);
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
  // A run by the bosbackup login, acknowledged with the ciphertext SHA-256, leaves the pull
  // marker that the deploy tick reads.
  const pulled = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(pulled.snapshot_utc, meta.snapshot_utc);
  assert.equal(pulled.ciphertext_sha256, meta.ciphertext.sha256);
  assert.match(run.stderr, /ack ok/);
});

test('a bosbackup run with no acknowledgement, a wrong hash or no line in time leaves no pull marker', {skip: !hasAge && 'age is not installed'}, async () => {
  const cases: [Answer, number, RegExp][] = [['none', 900, /NO ACK end of input/], ['wrong', 900, /NO ACK the acknowledgement is not/], ['silent', 2, /NO ACK no line within/]];
  for (const [answer, seconds, why] of cases) {
    rmSync(marker, {force: true});
    const run = await runProgram(join(work, 'dump_password'), 'bosbackup', answer, seconds);
    assert.equal(run.status, 3, answer + ': ' + run.stderr);
    assert.match(run.stderr, why);
    assert.equal(existsSync(marker), false, answer);
    // The stream itself was whole.
    assert.equal(cipherSha(run.stdout).length, 64);
  }
});

test('a run by another sudo user does not wait and leaves no pull marker', {skip: !hasAge && 'age is not installed'}, async () => {
  rmSync(marker, {force: true});
  const run = await runProgram(join(work, 'dump_password'), 'wgadmin', 'silent');
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(existsSync(marker), false);
});

test('a wrong dump password makes no dump', {skip: !hasAge && 'age is not installed'}, async () => {
  writeFileSync(join(work, 'wrong_password'), 'wrong-password-0123456789abcdef\n', {mode: 0o600});
  const run = await runProgram(join(work, 'wrong_password'));
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout.length, 0);
});
