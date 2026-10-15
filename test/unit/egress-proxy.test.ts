// Egress proxy with fake DNS and dialer (no network): only the GitHub allowlist passes.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {connect, createServer as netServer, type Server, type Socket} from 'node:net';
import {request} from 'node:http';
import {createProxy, privateAddress} from '../../src/egress-proxy.ts';

const closers: (() => void)[] = [];
after(() => closers.forEach(c => c()));

async function setup(dns: Record<string, string>) {
  // A local echo server stands in for GitHub; the fake dialer connects there.
  const echo: Server = netServer(s => s.pipe(s));
  await new Promise<void>(r => echo.listen(0, '127.0.0.1', r));
  const dialed: string[] = [];
  const proxy = createProxy(async h => { if (!(h in dns)) throw new Error('nxdomain'); return dns[h]; },
    (ip, port) => { dialed.push(`${ip}:${port}`); return connect({host: '127.0.0.1', port: (echo.address() as any).port}); }, () => {});
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  closers.push(() => { proxy.close(); echo.close(); });
  const port = (proxy.address() as any).port;
  const tunnel = (target: string) => new Promise<{status: number; socket?: Socket}>((resolve, reject) => {
    const req = request({host: '127.0.0.1', port, method: 'CONNECT', path: target});
    req.on('connect', (res, socket) => resolve({status: res.statusCode!, socket}));
    req.on('error', reject);
    req.end();
  });
  return {port, tunnel, dialed};
}

test('CONNECT to github.com:443 and api.github.com:443 opens a tunnel', async () => {
  const p = await setup({'github.com': '140.82.112.3', 'api.github.com': '140.82.112.6'});
  for (const target of ['github.com:443', 'api.github.com:443']) {
    const {status, socket} = await p.tunnel(target);
    assert.equal(status, 200);
    const echoed = await new Promise<string>(r => { socket!.once('data', d => r(d.toString())); socket!.write('ping'); });
    assert.equal(echoed, 'ping'); socket!.destroy();
  }
  assert.deepEqual(p.dialed, ['140.82.112.3:443', '140.82.112.6:443']);
});

test('every other host, port, private resolution or plain request is refused', async () => {
  const p = await setup({'github.com': '10.0.0.5', 'example.com': '93.184.215.14'});
  for (const target of ['example.com:443', 'github.com:80', 'github.com:22', 'gist.github.com:443', 'evil.github.com.example:443', '140.82.112.3:443', 'github.com:443'])
    assert.equal((await p.tunnel(target)).status, 403, target);
  assert.deepEqual(p.dialed, []);
  const plain = await new Promise<number>(r => request({host: '127.0.0.1', port: p.port, path: 'http://example.com/'}, res => r(res.statusCode!)).end());
  assert.equal(plain, 403);
});

test('private address detection', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '172.20.0.2', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0'])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['140.82.112.3', '8.8.8.8', '2606:50c0:8000::153']) assert.equal(privateAddress(ip), false, ip);
});
