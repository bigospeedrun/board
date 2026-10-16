// Registry steps of .github/workflows/image.yml. Copied from bigospeedrun/site
// scripts/site-image-registry.mjs at 7e4dbea; changes go upstream first, then this copy
// is refreshed (like src/vendor/egress-proxy.mjs).
//   node scripts/image-registry.mjs exists <tag>        exit 0 if the tag exists, 1 if not
//   node scripts/image-registry.mjs digest <tag>        print the tag's manifest digest
//   node scripts/image-registry.mjs retag <from> <to>   point <to> at <from>'s manifest
//   node scripts/image-registry.mjs prune <keep>        delete all but the newest <keep> images
// Environment: GHCR_TOKEN (the workflow's GITHUB_TOKEN), GHCR_USER, IMAGE_OWNER, IMAGE_NAME;
// REGISTRY and GITHUB_API only for tests.
import {pathToFileURL} from 'node:url';

const accept = ['application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');

export function registryClient({registry = 'https://ghcr.io', api = 'https://api.github.com', owner, name, user, token, fetcher = fetch}) {
 const repository = `${owner}/${name}`;
 let bearer;
 async function auth() {
  if (bearer) return bearer;
  const response = await fetcher(`${registry}/token?scope=repository:${repository}:pull,push`, {headers: {Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`}});
  if (!response.ok) throw new Error(`registry token: HTTP ${response.status}`);
  return bearer = (await response.json()).token;
 }
 const manifest = async (reference, init = {}) => fetcher(`${registry}/v2/${repository}/manifests/${reference}`, {...init, headers: {Authorization: `Bearer ${await auth()}`, Accept: accept, ...init.headers}});

 return {
  async exists(tag) {
   const response = await manifest(tag, {method: 'HEAD'});
   if (response.status === 404) return false;
   if (!response.ok) throw new Error(`manifest ${tag}: HTTP ${response.status}`);
   return true;
  },
  async digest(tag) {
   const response = await manifest(tag, {method: 'HEAD'});
   const digest = response.headers.get('docker-content-digest');
   if (!response.ok || !/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error(`manifest ${tag}: HTTP ${response.status}`);
   return digest;
  },
  // Copy the manifest bytes, so <to> gets exactly <from>'s digest (no rebuild, no re-wrap).
  async retag(from, to) {
   const source = await manifest(from);
   if (!source.ok) throw new Error(`manifest ${from}: HTTP ${source.status}`);
   const body = Buffer.from(await source.arrayBuffer());
   const digest = source.headers.get('docker-content-digest');
   const current = await manifest(to, {method: 'HEAD'});
   if (current.ok && digest && current.headers.get('docker-content-digest') === digest) return 'unchanged';
   const put = await manifest(to, {method: 'PUT', body, headers: {'Content-Type': source.headers.get('content-type') ?? 'application/vnd.oci.image.manifest.v1+json'}});
   if (!put.ok) throw new Error(`put ${to}: HTTP ${put.status}`);
   return 'moved';
  },
  // Keep the newest <keep> tagged versions, every version tagged main or keep-*, and every
  // version newer than ten minutes before the oldest kept one (untagged parts of kept images).
  async prune(keep) {
   const headers = {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'};
   const versions = [];
   for (let page = 1; page <= 20; page++) {
    const response = await fetcher(`${api}/orgs/${owner}/packages/container/${name}/versions?per_page=100&page=${page}`, {headers});
    if (!response.ok) throw new Error(`package versions: HTTP ${response.status}`);
    const batch = await response.json();
    versions.push(...batch);
    if (batch.length < 100) break;
   }
   const tags = version => version.metadata?.container?.tags ?? [];
   const newest = versions.filter(version => tags(version).length).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
   if (newest.length <= keep) return [];
   const cutoff = Date.parse(newest[keep - 1].created_at) - 600_000;
   const removed = [];
   for (const version of versions) {
    if (tags(version).some(tag => tag === 'main' || tag.startsWith('keep-'))) continue;
    if (Date.parse(version.created_at) >= cutoff) continue;
    const response = await fetcher(`${api}/orgs/${owner}/packages/container/${name}/versions/${version.id}`, {method: 'DELETE', headers});
    if (!response.ok && response.status !== 404) throw new Error(`delete ${version.id}: HTTP ${response.status}`);
    removed.push(version.id);
   }
   return removed;
  },
 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const [command, ...args] = process.argv.slice(2);
 const env = process.env;
 const client = registryClient({registry: env.REGISTRY, api: env.GITHUB_API, owner: env.IMAGE_OWNER, name: env.IMAGE_NAME, user: env.GHCR_USER, token: env.GHCR_TOKEN});
 try {
  if (command === 'exists') process.exitCode = await client.exists(args[0]) ? 0 : 1;
  else if (command === 'digest') console.log(await client.digest(args[0]));
  else if (command === 'retag') console.log(`${args[1]}: ${await client.retag(args[0], args[1])}`);
  else if (command === 'prune') console.log(`pruned ${(await client.prune(Number(args[0]))).length} old image versions`);
  else throw new Error('usage: exists <tag> | digest <tag> | retag <from> <to> | prune <keep>');
 } catch (error) { console.error(String(error.message ?? error)); process.exitCode = 2; }
}
