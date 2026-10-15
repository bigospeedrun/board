// VENDORED from bigospeedrun/site ops/self-host/egress-proxy.mjs at commit 8a0ffdc
// (Worker 4, phase C). One egress proxy implementation for the project: change it
// upstream and copy it here again. The board runs it as its own container with
// EGRESS_ALLOW=github.com:443,api.github.com:443 on its own network.
// Egress allowlist proxy for the self-hosted site (lead decision, 2026-10-16). The site
// container has no route to the internet; its fetch calls (NODE_USE_ENV_PROXY=1,
// HTTPS_PROXY=http://egress:3128) go through here, and this proxy opens a TLS tunnel only
// to the hosts in EGRESS_ALLOW. It never sees request contents or secrets: the TLS session
// runs end to end between the site and the API.
// Run: node ops/self-host/egress-proxy.mjs   (EGRESS_PORT default 3128)
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {pathToFileURL} from 'node:url';

// /api/chat calls the Anthropic API and posts to two Discord webhooks.
export const defaultAllow = 'api.anthropic.com:443,discord.com:443';

export function createEgressProxy(allow = defaultAllow, log = message => console.log(message)) {
 const allowed = new Set(allow.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean));
 const server = createServer((req, res) => {
  // Plain HTTP requests could carry data anywhere in clear text: only CONNECT is served.
  log(`refused ${req.method} (only CONNECT)`);
  res.writeHead(405, {'Content-Type': 'text/plain', 'Connection': 'close'}).end('Only CONNECT to allowed hosts.\n');
 });
 server.on('connect', (req, client, head) => {
  const target = (req.url ?? '').toLowerCase();
  const match = /^([a-z0-9.-]+):(\d{1,5})$/.exec(target);
  if (!match || !allowed.has(target)) {
   log(`refused CONNECT ${target.slice(0, 100)}`);
   client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
   return;
  }
  const upstream = connect(Number(match[2]), match[1], () => {
   client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if (head.length) upstream.write(head);
   upstream.pipe(client); client.pipe(upstream);
  });
  const close = () => { upstream.destroy(); client.destroy(); };
  upstream.setTimeout(120_000, close); client.setTimeout(120_000, close);
  upstream.on('error', () => { if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); });
  client.on('error', close);
 });
 return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const allow = process.env.EGRESS_ALLOW ?? defaultAllow;
 const server = createEgressProxy(allow);
 server.listen(Number(process.env.EGRESS_PORT ?? 3128), '0.0.0.0', () => console.log(`egress proxy allows ${allow}`));
 const stop = () => server.close(() => process.exit(0));
 process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
