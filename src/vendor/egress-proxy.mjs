// VENDORED from bigospeedrun/site ops/self-host/egress-proxy.mjs at commit cb1123e.
// One egress proxy implementation for the project: change it upstream and copy it here
// again. Local changes: the site-specific comments are trimmed and defaultAllow is empty,
// so a container started without EGRESS_ALLOW allows nothing. The board runs it as its
// own container with EGRESS_ALLOW=github.com:443,api.github.com:443 on its own network.
// Egress allowlist proxy. The calling container has no route to the internet; its fetch
// calls (NODE_USE_ENV_PROXY=1, HTTPS_PROXY=http://<proxy>:3128) go through here, and this
// proxy opens a TLS tunnel only to the host:port pairs in EGRESS_ALLOW. It never sees
// request contents or secrets: the TLS session runs end to end.
// Hardening: an allowed name must resolve only to public addresses, and the tunnel goes to
// the checked address, so DNS cannot point it inside. Tunnels are limited in number, idle
// time and total lifetime.
// Run: node src/vendor/egress-proxy.mjs   (EGRESS_PORT default 3128)
import {createServer} from 'node:http';
import {connect, BlockList, isIP} from 'node:net';
import {lookup} from 'node:dns/promises';
import {pathToFileURL} from 'node:url';

export const defaultAllow = '';

// Addresses a tunnel must never reach: private, loopback, link-local, CGNAT, and other
// non-public ranges. An IPv4-mapped or NAT64 IPv6 answer is refused as a whole.
// One list per family: Node matches an IPv4 address against IPv4-mapped IPv6 rules too, so a
// single list with ::ffff:0:0/96 would block every IPv4 address.
const blocked4 = new BlockList(), blocked6 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
 ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
 ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
 ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked6.addSubnet(network, prefix, 'ipv6');
export const isPublic = address => {
 const family = isIP(address);
 return family === 4 ? !blocked4.check(address, 'ipv4') : family === 6 ? !blocked6.check(address, 'ipv6') : false;
};

// A chat reply streams for up to 45 s and the site's requests time out at 65 s, so the
// lifetime is above both; an idle tunnel closes much sooner.
export const defaultLimits = {maxTunnels: 32, idleMs: 30_000, lifetimeMs: 90_000, dnsMs: 5_000};
const defaultResolve = async host => (await lookup(host, {all: true})).map(entry => entry.address);
const defaultDial = (address, port) => connect({host: address, port});

// resolve(host) -> addresses and dial(address, port) -> socket can be replaced in tests.
export function createEgressProxy(allow = defaultAllow, log = message => console.log(message), {resolve = defaultResolve, dial = defaultDial, ...limits} = {}) {
 const {maxTunnels, idleMs, lifetimeMs, dnsMs} = {...defaultLimits, ...limits};
 const allowed = new Set(allow.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean));
 let open = 0;
 const server = createServer((req, res) => {
  // Plain HTTP requests could carry data anywhere in clear text: only CONNECT is served.
  log(`refused ${req.method} (only CONNECT)`);
  res.writeHead(405, {'Content-Type': 'text/plain', 'Connection': 'close'}).end('Only CONNECT to allowed hosts.\n');
 });
 server.on('connect', async (req, client, head) => {
  const target = (req.url ?? '').toLowerCase();
  client.on('error', () => client.destroy());
  const refuse = (status, why) => {
   log(`refused CONNECT ${target.slice(0, 100)}: ${why}`);
   client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  };
  const match = /^([a-z0-9.-]+):(\d{1,5})$/.exec(target);
  if (!match || !allowed.has(target)) return refuse('403 Forbidden', 'not allowed');
  if (open >= maxTunnels) return refuse('503 Service Unavailable', `${maxTunnels} tunnels open`);
  open++;
  let released = false, upstream, lifetime;
  const release = () => { if (!released) { released = true; open--; clearTimeout(lifetime); } };
  const close = () => { release(); upstream?.destroy(); client.destroy(); };
  client.on('close', close);
  let addresses;
  try {
   addresses = await Promise.race([resolve(match[1]), new Promise((_, fail) => setTimeout(() => fail(new Error('timeout')), dnsMs).unref())]);
  } catch { release(); return refuse('502 Bad Gateway', 'DNS failed'); }
  // Every answer must be public: a mixed answer could still reach an inside address.
  const inside = addresses.find(address => !isPublic(address));
  if (!addresses.length || inside) { release(); return refuse('403 Forbidden', `resolves to ${inside ?? 'nothing'}`); }
  if (released) return;
  let established = false;
  upstream = dial(addresses[0], Number(match[2]));
  lifetime = setTimeout(close, lifetimeMs);
  upstream.setTimeout(idleMs, close); client.setTimeout(idleMs, close);
  upstream.once('connect', () => {
   established = true;
   client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if (head.length) upstream.write(head);
   upstream.pipe(client); client.pipe(upstream);
  });
  upstream.on('error', () => { if (established) close(); else { release(); refuse('502 Bad Gateway', 'upstream refused'); } });
  upstream.on('close', () => { if (established) close(); });
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
