// deploy/backup/bos-board-backup-dump without a database: the pull marker waits for the
// backup host's acknowledgement (one line, the run's ciphertext SHA-256), and the dump
// password reaches only the psql/pg_dump calls. The program runs as a module with fakes;
// test/db/dump-program.test.ts runs it against a real PostgreSQL.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

const program = new URL('../../deploy/backup/bos-board-backup-dump', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'board-dump-'));
after(() => rmSync(dir, {recursive: true, force: true}));
const expected = 'ab'.repeat(32);

const driver = `
import importlib.machinery, importlib.util, json, os, sys, types
loader = importlib.machinery.SourceFileLoader('dump', sys.argv[1])
spec = importlib.util.spec_from_loader('dump', loader); m = importlib.util.module_from_spec(spec); loader.exec_module(m)
m.syslog = types.SimpleNamespace(syslog=lambda *a: None, LOG_INFO=6)
m.PULL_MARKER = sys.argv[2]
if sys.argv[3] == 'ack':
    sys.stdout.write('the stream\\n')
    ok = m.finish_pull({'snapshot_utc': '2026-10-16T10:00:00Z', 'ciphertext_sha256': '${expected}'}, '${expected}', seconds=float(sys.argv[4]))
    sys.exit(0 if ok else m.EXIT_NO_ACK)
m.PASSWORD_FILE, m.DOCKER, m.AGE = sys.argv[4:7]
pg_env = m.load_password()
print(json.dumps({'own': 'PGPASSWORD' in os.environ, 'psql': m.dump_role_query('cid', 'SELECT 1', pg_env),
                  'age': m.run([m.AGE, '--version']).strip(), 'ps': m.run([m.DOCKER, 'ps']).strip()}))`;

type Run = {code: number | null; stdout: string; stderr: string; stdoutEndedFirst: boolean};
// Runs the driver; `answer` gets the child's stdin once its stdout has ended (the stream is over).
function run(args: string[], answer: (stdin: NodeJS.WritableStream) => void = s => s.end()): Promise<Run> {
  return new Promise(done => {
    const child = spawn('python3', ['-I', '-B', '-c', driver, program, join(dir, 'last-pull.json'), ...args], {env: {PATH: process.env.PATH}});
    let stdout = '', stderr = '', ended = false, exited = false;
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.stdin.on('error', () => {});   // a late answer to a program that already gave up
    child.stdout.on('end', () => { ended = !exited; answer(child.stdin); });
    child.on('exit', () => { exited = true; });
    child.on('close', code => done({code, stdout, stderr, stdoutEndedFirst: ended}));
  });
}
const marker = () => join(dir, 'last-pull.json');

test('the exact ciphertext SHA-256 after the stream writes the pull marker', async () => {
  rmSync(marker(), {force: true});
  const r = await run(['ack', '30'], s => s.end(expected + '\n'));
  assert.equal(r.code, 0, r.stderr);
  // The program closed its stdout before it waited, so the client saw the end of the stream.
  assert.equal(r.stdoutEndedFirst, true);
  assert.equal(r.stdout, 'the stream\n');
  assert.deepEqual(JSON.parse(readFileSync(marker(), 'utf8')), {snapshot_utc: '2026-10-16T10:00:00Z', ciphertext_sha256: expected});
  assert.match(r.stderr, /ack ok/);
});

test('a wrong line, end of input or no line in time writes no marker and exits 3', async () => {
  const cases: [string, (s: NodeJS.WritableStream) => void, RegExp][] = [
    ['other hash', s => s.end('cd'.repeat(32) + '\n'), /not this run's ciphertext_sha256/],
    ['upper case', s => s.end(expected.toUpperCase() + '\n'), /not this run's/],
    ['CRLF', s => s.end(expected + '\r\n'), /not this run's/],
    ['trailing space', s => s.end(expected + ' \n'), /not this run's/],
    ['no newline', s => s.end(expected), /end of input/],
    ['nothing', s => s.end(), /end of input/],
    ['too long', s => s.end('a'.repeat(500)), /too long/],
    ['timeout', s => setTimeout(() => s.end(expected + '\n'), 2500), /no line within/],
  ];
  for (const [name, answer, why] of cases) {
    rmSync(marker(), {force: true});
    const r = await run(['ack', '1'], answer);
    assert.equal(r.code, 3, name);
    assert.equal(existsSync(marker()), false, name);
    assert.match(r.stderr, why, name);
    assert.match(r.stderr, /no pull marker/, name);
  }
});

test('the dump password goes only to the psql/pg_dump calls, by name', async () => {
  const password = 'p'.repeat(12) + '0123456789abcdef';
  writeFileSync(join(dir, 'dump_password'), password + '\n', {mode: 0o600});
  // A fake docker and age: they print their arguments and whether PGPASSWORD is set, never its value.
  const fake = join(dir, 'fake');
  writeFileSync(fake, '#!/bin/sh\nif [ -n "$PGPASSWORD" ]; then echo "set $*"; else echo "unset $*"; fi\n', {mode: 0o755});
  const r = await run(['env', join(dir, 'dump_password'), fake, fake]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.own, false);
  assert.match(out.psql, /^set exec -e PGPASSWORD -u postgres cid psql /);
  assert.equal(out.age, 'unset --version');
  assert.equal(out.ps, 'unset ps');
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(password));
});
