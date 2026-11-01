// The health checks of deploy/compose.board.yml. On 2026-11-01 board-auth (3 s timeout, every 15 s) went
// unhealthy twice while the host load was 4 to 13 and disk wait reached 46 ms: `node -e` needs more than 3 s to
// start on a busy box. A probe that gives up too early marks a healthy service unhealthy.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('every health check of the board stack allows its probe at least 10 s', () => {
  const lines = readFileSync(new URL('../../deploy/compose.board.yml', import.meta.url), 'utf8').split('\n');
  const timeouts: number[] = [];
  lines.forEach((line, i) => {
    if (!/^\s+healthcheck:\s*$/.test(line)) return;
    const block = lines.slice(i + 1, i + 6).join('\n');
    const timeout = /^\s+timeout:\s*(\d+)s\s*$/m.exec(block);
    assert.ok(timeout, `healthcheck at line ${i + 1} has a timeout in seconds`);
    timeouts.push(Number(timeout[1]));
  });
  assert.equal(timeouts.length, 3, 'board-db, board-api and board-auth');
  for (const seconds of timeouts) assert.ok(seconds >= 10, `timeout ${seconds}s is under 10 s`);
});
