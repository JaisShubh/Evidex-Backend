import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicGithubMetadata, parsePublicGithubRepository } from '../src/services/github.service.js';

test('GitHub repository URLs are canonicalized without accepting arbitrary hosts', () => {
  assert.deepEqual(parsePublicGithubRepository('https://github.com/example/repo.git'), {
    owner: 'example', repository: 'repo', canonicalUrl: 'https://github.com/example/repo',
  });
  for (const url of ['http://github.com/example/repo', 'https://github.com.evil.test/example/repo', 'https://user@github.com/example/repo', 'https://github.com/example/repo/tree/main', 'https://github.com/example/repo?x=1']) {
    assert.throws(() => parsePublicGithubRepository(url), { code: 'INVALID_REPOSITORY_URL' });
  }
});

test('public repository check returns limited metadata and does not assert ownership', async () => {
  let requestedUrl;
  const metadata = await fetchPublicGithubMetadata('https://github.com/example/repo', async (url, options) => {
    requestedUrl = url;
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    return new Response(JSON.stringify({ full_name: 'example/repo', private: false, description: 'Test repo', default_branch: 'main', pushed_at: '2026-10-01T00:00:00Z', archived: false, stargazers_count: 4 }), { status: 200 });
  });
  assert.equal(requestedUrl, 'https://api.github.com/repos/example/repo');
  assert.equal(metadata.providerStatus, 'public');
  assert.equal(metadata.stars, 4);
  assert.equal('owner' in metadata, false);
});

test('private or missing GitHub repositories are not reported as verified', async () => {
  const result = await fetchPublicGithubMetadata('https://github.com/example/private', async () => new Response('', { status: 404 }));
  assert.equal(result.providerStatus, 'not_found_or_private');
});

test('GitHub transport failures return a bounded provider error', async () => {
  await assert.rejects(fetchPublicGithubMetadata('https://github.com/example/repo', async () => { throw new Error('secret connection detail'); }), {
    status: 502, code: 'GITHUB_UNAVAILABLE', message: 'GitHub could not be reached. Please try again later.',
  });
});
