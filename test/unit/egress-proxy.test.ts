// The vendored egress proxy with the board allowlist (no network: a local echo
// server stands in for an allowed host).
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as netServer, type Socket} from 'node:net';
import {request} from 'node:http';
import {createEgressProxy} from '../../src/vendor/egress-proxy.mjs';

const BOARD_ALLOW = 'github.com:443,api.github.com:443';
const closers: (() => void)[] = [];
after(() => closers.forEach(c => c()));

async function proxyWith(allow: string) {
  const proxy = createEgressProxy(allow, () => {});
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  closers.push(() => proxy.close());
  const port = (proxy.address() as any).port;
  const tunnel = (target: string) => new Promise<{status: number; socket: Socket}>((resolve, reject) => {
    const req = request({host: '127.0.0.1', port, method: 'CONNECT', path: target});
    req.on('connect', (res, socket) => resolve({status: res.statusCode!, socket}));
    req.on('error', reject);
    req.end();
  });
  return {port, tunnel};
}

test('board allowlist: every non-GitHub target and plain HTTP is refused', async () => {
  const p = await proxyWith(BOARD_ALLOW);
  for (const target of ['example.com:443', 'github.com:80', 'github.com:22', 'gist.github.com:443', 'evil.github.com.example:443',
      '140.82.112.3:443', 'board-db:5432', '127.0.0.1:443', 'GITHUB.COM:443x']) {
    const r = await p.tunnel(target); r.socket.destroy();
    assert.equal(r.status, 403, target);
  }
  const plain = await new Promise<number>(r => request({host: '127.0.0.1', port: p.port, path: 'http://example.com/'}, res => r(res.statusCode!)).end());
  assert.equal(plain, 405);
});

test('an allowed target opens a tunnel', async () => {
  const echo = netServer(s => s.pipe(s));
  await new Promise<void>(r => echo.listen(0, '127.0.0.1', r));
  closers.push(() => echo.close());
  const p = await proxyWith(`127.0.0.1:${(echo.address() as any).port}`);
  const {status, socket} = await p.tunnel(`127.0.0.1:${(echo.address() as any).port}`);
  assert.equal(status, 200);
  assert.equal(await new Promise<string>(r => { socket.once('data', d => r(d.toString())); socket.write('ping'); }), 'ping');
  socket.destroy();
});
