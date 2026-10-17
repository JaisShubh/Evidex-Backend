const repositoryPathPart = /^[A-Za-z0-9_.-]{1,100}$/;

export function parsePublicGithubRepository(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw Object.assign(new Error('Repository URL must be a valid public GitHub repository URL.'), { status: 400, code: 'INVALID_REPOSITORY_URL' }); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('Only canonical HTTPS URLs on github.com are supported.'), { status: 400, code: 'INVALID_REPOSITORY_URL' });
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some(part => !repositoryPathPart.test(part) || part === '.' || part === '..')) {
    throw Object.assign(new Error('Use a repository URL in the form https://github.com/owner/repository.'), { status: 400, code: 'INVALID_REPOSITORY_URL' });
  }
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, '');
  if (!repository) throw Object.assign(new Error('Repository name is required.'), { status: 400, code: 'INVALID_REPOSITORY_URL' });
  return { owner, repository, canonicalUrl: `https://github.com/${owner}/${repository}` };
}

export async function fetchPublicGithubMetadata(rawUrl, fetchImpl = fetch) {
  const parsed = parsePublicGithubRepository(rawUrl);
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EVIDEX-backend' },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    throw Object.assign(new Error('GitHub could not be reached. Please try again later.'), { status: 502, code: 'GITHUB_UNAVAILABLE' });
  }
  if (response.status === 404) return { providerStatus: 'not_found_or_private', repositoryUrl: parsed.canonicalUrl };
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw Object.assign(new Error('GitHub rate limit reached. Please retry later.'), { status: 503, code: 'GITHUB_RATE_LIMITED' });
  }
  if (!response.ok) throw Object.assign(new Error('GitHub could not verify repository metadata right now.'), { status: 502, code: 'GITHUB_UNAVAILABLE' });
  let data;
  try { data = await response.json(); }
  catch { throw Object.assign(new Error('GitHub returned invalid repository metadata.'), { status: 502, code: 'GITHUB_INVALID_RESPONSE' }); }
  if (data.private === true || typeof data.full_name !== 'string' || !data.default_branch) {
    return { providerStatus: 'not_found_or_private', repositoryUrl: parsed.canonicalUrl };
  }
  return {
    providerStatus: 'public', repositoryUrl: parsed.canonicalUrl,
    fullName: data.full_name, description: typeof data.description === 'string' ? data.description.slice(0, 1000) : '',
    defaultBranch: String(data.default_branch).slice(0, 100), pushedAt: data.pushed_at ? new Date(data.pushed_at) : undefined,
    archived: Boolean(data.archived), stars: Number.isInteger(data.stargazers_count) ? data.stargazers_count : undefined,
  };
}
