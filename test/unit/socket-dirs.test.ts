// deploy/socket-dirs.sh with a fake getent (no root needed for these cases). The passing
// case needs root-owned directories, so it is checked on the VPS (plan E1), not here.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const script = new URL('../../deploy/socket-dirs.sh', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'board-sockets-'));
const sockets = join(dir, 'run');
for (const name of ['api', 'auth']) mkdirSync(join(sockets, name), {recursive: true});
after(() => rmSync(dir, {recursive: true, force: true}));

function run(gidLine: string | null, releaseGid: string, ...args: string[]) {
  writeFileSync(join(dir, 'getent'), gidLine === null ? '#!/bin/sh\nexit 2\n' : `#!/bin/sh\n[ "$1 $2" = "group wg-caddy" ] && echo '${gidLine}'\n`, {mode: 0o755});
  writeFileSync(join(dir, 'release.env'), `BOARD_IMAGE=x\nBOARD_SOCKET_GID=${releaseGid}\n`);
  return spawnSync('bash', [script, ...args], {encoding: 'utf8',
    env: {PATH: process.env.PATH, BOARD_ROOT: dir, BOARD_SOCKET_DIR: sockets, BOARD_GETENT: join(dir, 'getent')}});
}

test('a group that does not resolve fails loudly (wg-caddy not running)', () => {
  const r = run(null, '64543', '--check');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /group wg-caddy does not resolve/);
});

test('a changed wg-caddy gid fails and names the value to set', () => {
  for (const args of [['--check'], []]) {
    const r = run('wg-caddy:x:61000:', '64543', ...args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /gid is 61000 but release.env has BOARD_SOCKET_GID=64543: set BOARD_SOCKET_GID=61000/);
  }
});

test('--check fails on a directory that is not root:<gid> 2770', () => {
  const r = run('wg-caddy:x:64543:', '64543', '--check');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /run\/api is not root:64543 mode 2770/);
});
