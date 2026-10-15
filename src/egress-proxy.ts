// Allowlist egress proxy for board-auth: HTTPS CONNECT to github.com:443 and
// api.github.com:443 only. Every other host, port, method or plain HTTP request is
// refused (403). A name that resolves to a private, loopback or link-local address is
// refused too, so DNS cannot point the tunnel inside. Tunnels end after 30 s.
// Env: PROXY_PORT (default 3128).
import {createServer, type IncomingMessage} from 'node:http';
import {connect, isIP, type Socket} from 'node:net';
import {lookup} from 'node:dns/promises';

export const ALLOW = new Set(['github.com:443', 'api.github.com:443']);
const TUNNEL_MS = 30000;

export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

type Resolve = (host: string) => Promise<string>;
type Dial = (ip: string, port: number) => Socket;
const defaultResolve: Resolve = async host => (await lookup(host)).address;
const defaultDial: Dial = (ip, port) => connect({host: ip, port});

export function createProxy(resolve: Resolve = defaultResolve, dial: Dial = defaultDial, log = (entry: object) => console.log(JSON.stringify(entry))) {
  const server = createServer((req, res) => {
    log({refused: 'not_connect', method: req.method});
    res.writeHead(403, {'Content-Type': 'text/plain'}).end('CONNECT only\n');
  });
  server.maxConnections = 20;
  server.on('connect', async (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = (req.url ?? '').toLowerCase();
    const refuse = (why: string) => { log({refused: why, target: target.slice(0, 100)}); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); };
    if (!ALLOW.has(target)) return refuse('not_allowed');
    const [host, port] = target.split(':');
    let ip: string;
    try { ip = await resolve(host); } catch { return refuse('dns'); }
    if (privateAddress(ip)) return refuse('private_address');
    const upstream = dial(ip, Number(port));
    const timer = setTimeout(() => { upstream.destroy(); client.destroy(); }, TUNNEL_MS);
    const done = () => { clearTimeout(timer); upstream.destroy(); client.destroy(); };
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
      log({allowed: target});
    });
    upstream.on('error', done); client.on('error', done);
    upstream.on('close', done); client.on('close', done);
  });
  return server;
}

if (import.meta.main) {
  createProxy().listen(Number(process.env.PROXY_PORT ?? 3128), '0.0.0.0');
  console.log(JSON.stringify({service: 'board-egress', allow: [...ALLOW]}));
}
