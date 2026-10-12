import { GitHubError } from '@ddv/github';
import { describe, expect, it } from 'vitest';
import {
  createServices,
  EMPTY_RUNS,
  GitHubChangeSource,
  GitHubRepoReader,
  loadConfigFrom,
  MemoryBlobStore,
  MemoryRepoReader,
  systemEnv,
  TreeIndex,
} from './index.ts';

const DOC = `---\nid: REQ-1\nkind: requirement\ntitle: 要件\n---\n# 要件\n\n本文\n`;

describe('MemoryRepoReader と createServices（ブラウザでも同じ組み立て）', () => {
  it('MemoryRepoReader は listFiles・stat・exists・tryReadText・readBinary を持つ', async () => {
    const r = new MemoryRepoReader({ 'docs/a.md': 'A', 'docs/sub/b.md': 'B', 'img/x.png': new Uint8Array([1, 2]) });
    expect(await r.listFiles('docs')).toEqual(['docs/a.md', 'docs/sub/b.md']);
    expect(await r.listFiles('', (p) => p.endsWith('.png'))).toEqual(['img/x.png']);
    expect(await r.exists('docs/a.md')).toBe(true);
    expect(await r.exists('docs')).toBe(false);
    expect(await r.tryReadText('nope.md')).toBeNull();
    await expect(r.readText('nope.md')).rejects.toMatchObject({ status: 404 });
    await expect(r.readText('../x')).rejects.toMatchObject({ status: 404 });
    expect([...(await r.readBinary('img/x.png'))]).toEqual([1, 2]);
    expect(await r.stat('docs/a.md')).toMatchObject({ path: 'docs/a.md', size: 1 });
  });

  it('createServices は RepoReader だけで設定・ツリー・文書を返す（Node の API を使わない）', async () => {
    const reader = new MemoryRepoReader({ 'ddv.config.yaml': 'docsRoot: docs\n', 'docs/req.md': DOC });
    const config = await loadConfigFrom(reader);
    const s = createServices({ env: systemEnv, reader, getConfig: () => config, runs: EMPTY_RUNS, repoName: 'repo', repoRoot: 'o/repo' });
    expect(s.docs.config()).toMatchObject({ repoRoot: 'o/repo', repoName: 'repo' });
    const tree = await s.docs.tree();
    expect(tree.docs.map((d) => d.path)).toEqual(['docs/req.md']);
    expect(await s.docs.file('docs/req.md')).toBe(DOC);
    expect(s.pr).toBeUndefined();
    expect(s.history.latest()).toEqual({});
  });
});

describe('GitHub から読む RepoReader（偽の GitHub API）', () => {
  const tree = {
    sha: 'c1',
    truncated: false,
    tree: [
      { path: 'docs', type: 'tree', mode: '040000', sha: 't1' },
      { path: 'docs/a.md', type: 'blob', mode: '100644', sha: 'b1', size: 5 },
      { path: 'link', type: 'blob', mode: '120000', sha: 'b2', size: 4 },
      { path: 'node_modules/x.js', type: 'blob', mode: '100644', sha: 'b3', size: 1 },
    ],
  };
  const client = (calls: string[]) => ({
    rest: async <T>(_m: string, p: string) => {
      calls.push(p);
      if (p.includes('/git/trees/')) return tree as T;
      if (p.includes('/git/blobs/b1')) return { content: btoa('hello'), encoding: 'base64' } as T;
      throw new GitHubError('notFound', 404, p);
    },
  });

  it('TreeIndex は blob だけ（symlink・node_modules を除く）、トークンありは Blobs API、BlobStore に残す', async () => {
    const calls: string[] = [];
    const gh = client(calls);
    const index = await TreeIndex.load(gh, 'o', 'r', 'c1');
    expect([...index.entries.keys()]).toEqual(['docs/a.md']);
    const store = new MemoryBlobStore();
    const r = new GitHubRepoReader({ client: gh, owner: 'o', repo: 'r', sha: 'c1', tree: index, store, hasToken: () => true });
    expect(r.revision).toBe('c1');
    expect(await r.readText('docs/a.md')).toBe('hello');
    expect(await r.stat('docs/a.md')).toEqual({ path: 'docs/a.md', size: 5, sha: 'b1' });
    expect(await r.tryReadText('link')).toBeNull();
    expect(await r.readText('docs/a.md')).toBe('hello');
    expect(calls.filter((c) => c.includes('/git/blobs/'))).toHaveLength(1);
    expect(await store.get('b1')).not.toBeNull();
  });

  it('トークンなしは raw.githubusercontent.com を credentials: omit で読み、404 ならフォークの head を一度だけ試す', async () => {
    const urls: string[] = [];
    const inits: RequestInit[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      urls.push(url);
      inits.push(init);
      return url.includes('/fork/r/') ? new Response('from fork') : new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const index = await TreeIndex.load(client([]), 'o', 'r', 'c1');
    const r = new GitHubRepoReader({ client: client([]), owner: 'o', repo: 'r', sha: 'c1', tree: index, store: new MemoryBlobStore(), hasToken: () => false, headRepo: 'fork/r', fetch: fakeFetch });
    expect(await r.readText('docs/a.md')).toBe('from fork');
    expect(urls).toEqual(['https://raw.githubusercontent.com/o/r/c1/docs/a.md', 'https://raw.githubusercontent.com/fork/r/c1/docs/a.md']);
    expect(inits.every((i) => i.credentials === 'omit' && i.referrerPolicy === 'no-referrer')).toBe(true);
  });

  it('GitHubChangeSource は pulls/files から name-status と diff を作る', async () => {
    const paths: string[] = [];
    const files = [
      { filename: 'docs/a.md', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'docs/new.md', status: 'added', patch: '@@ -0,0 +1 @@\n+n' },
      { filename: 'docs/c.md', previous_filename: 'docs/old.md', status: 'renamed' },
      { filename: 'docs/gone.md', status: 'removed' },
    ];
    const src = new GitHubChangeSource({ paginate: async <T>(p: string) => (paths.push(p), files as T[]) }, { owner: 'o', repo: 'r', pr: 7 });
    expect(await src.nameStatus('base', 'head')).toEqual([
      { status: 'M', path: 'docs/a.md' },
      { status: 'A', path: 'docs/new.md' },
      { status: 'R', path: 'docs/c.md', oldPath: 'docs/old.md' },
      { status: 'D', path: 'docs/gone.md' },
    ]);
    const diff = await src.diff('base', 'head', ['docs/a.md', 'docs/new.md']);
    expect(diff).toContain('diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@');
    expect(diff).toContain('--- /dev/null\n+++ b/docs/new.md');
    expect(paths).toEqual(['/repos/o/r/pulls/7/files?per_page=100']);
  });
});