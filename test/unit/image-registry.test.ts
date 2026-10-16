// Registry steps of the image workflow, against a fake registry and API (no network).
// The same cases as the site's test of the file this copy comes from.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registryClient} from '../../scripts/image-registry.mjs';

test('registry steps: exists, digest, retag by copying the manifest, and prune keeps main and recent images', async () => {
  const manifests: Record<string, {body: string; digest: string}> = {'sha-a': {body: '{"m":"a"}', digest: 'sha256:aaa'}, main: {body: '{"m":"b"}', digest: 'sha256:' + 'b'.repeat(64)}};
  const versions = Array.from({length: 35}, (_, i) => ({id: i, created_at: new Date(Date.UTC(2026, 9, 16, 0, 0) - i * 3_600_000).toISOString(), metadata: {container: {tags: i === 34 ? ['main'] : [`sha-${i}`]}}}));
  versions.push({id: 99, created_at: new Date(Date.UTC(2026, 9, 1)).toISOString(), metadata: {container: {tags: []}}});
  const deleted: string[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = new URL(url).pathname;
    if (path === '/token') return Response.json({token: 't'});
    const tag = path.match(/\/manifests\/(.+)$/)?.[1];
    if (tag) {
      if (method === 'PUT') { manifests[tag] = {body: String(init.body), digest: 'sha256:aaa'}; return new Response(null, {status: 201}); }
      const found = manifests[tag];
      if (!found) return new Response(null, {status: 404});
      return new Response(method === 'HEAD' ? null : found.body, {headers: {'docker-content-digest': found.digest, 'content-type': 'application/vnd.oci.image.manifest.v1+json'}});
    }
    if (path === '/orgs/bigospeedrun/packages/container/board/versions' && method === 'GET') return Response.json(new URL(url).searchParams.get('page') === '1' ? versions : []);
    if (method === 'DELETE' && path.startsWith('/orgs/bigospeedrun/packages/container/board/versions/')) { deleted.push(path); return new Response(null, {status: 204}); }
    return new Response(null, {status: 500});
  }) as typeof fetch;
  const client = registryClient({registry: 'https://registry.test', api: 'https://api.test', owner: 'bigospeedrun', name: 'board', user: 'u', token: 't', fetcher});
  assert.equal(await client.exists('sha-a'), true);
  assert.equal(await client.exists('sha-zzz'), false);
  assert.equal(await client.digest('main'), 'sha256:' + 'b'.repeat(64));
  assert.equal(await client.retag('sha-a', 'main'), 'moved');
  assert.equal(manifests.main.body, '{"m":"a"}');
  assert.equal(await client.retag('sha-a', 'main'), 'unchanged');
  // Versions 0-29 are the newest 30; 30-33 and the old untagged 99 go; 34 is tagged main.
  assert.deepEqual((await client.prune(30)).sort((a: number, b: number) => a - b), [30, 31, 32, 33, 99]);
  assert.equal(deleted.length, 5);
});

test('the image workflow tests first, tags by commit and main, and keeps 30 images', () => {
  const yml = readFileSync(new URL('../../.github/workflows/image.yml', import.meta.url), 'utf8');
  assert.match(yml, /branches: \[main\]/);
  assert.ok(yml.indexOf('npm test') < yml.indexOf('docker buildx build'), 'tests run before the build');
  assert.match(yml, /-t "\$image:sha-\$COMMIT" -t "\$image:main" --push/);
  assert.match(yml, /image-registry\.mjs prune 30/);
  assert.match(yml, /packages: write/);
  assert.doesNotMatch(yml, /pull_request/); // a fork's PR never gets a write token
});
