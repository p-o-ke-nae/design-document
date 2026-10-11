import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient, TokenResolver } from '@ddv/github';
import { fakeGitHub, fakeGitHubState } from './github-fixture.ts';
import { ReviewError } from './review-error.ts';
import { setStatus, StatusCommitter } from './status-commit.ts';

describe('setStatus', () => {
  it('[DD-REVCMT-SETST-P001] [DD-REVCMT-SETST-T001] [DD-REVCMT-SETST-T002] no front matter → unchanged with a warning', () => {
    const r = setStatus('# 見出し\n\n本文\n');
    expect(r).toMatchObject({ changed: false, text: '# 見出し\n\n本文\n' });
    expect(r.warning).toBeTruthy();
    expect(setStatus('---\nid: A\n\n# 閉じていない\n').changed).toBe(false);
  });

  it('[DD-REVCMT-SETST-P002] [DD-REVCMT-SETST-T003] [DD-REVCMT-SETST-T004] no status line → inserted before the closing ---', () => {
    const r = setStatus('---\nid: A\ntitle: t\n---\n\n# 本文\n');
    expect(r).toMatchObject({ changed: true, text: '---\nid: A\ntitle: t\nstatus: approved\n---\n\n# 本文\n', line: 4 });
    expect(r.suggestion).toBe('status: approved\n---');
    expect(setStatus('---\r\nid: A\r\n---\r\n本文\r\n').text).toBe('---\r\nid: A\r\nstatus: approved\r\n---\r\n本文\r\n');
  });

  it('[DD-REVCMT-SETST-P003] [DD-REVCMT-SETST-T005] [DD-REVCMT-SETST-T006] already approved → unchanged', () => {
    const text = '---\nstatus: "approved"\n---\n';
    expect(setStatus(text)).toMatchObject({ changed: false, text, line: 2 });
  });

  it('[DD-REVCMT-SETST-P004] [DD-REVCMT-SETST-T005] [DD-REVCMT-SETST-T007] replaces only the value of the line (EOL, quotes, comment, key order stay)', () => {
    const text = '---\r\nid: A\r\nstatus:   review   # 要レビュー\r\ntitle: "t"\r\n---\r\n本文';
    const r = setStatus(text);
    expect(r.changed).toBe(true);
    expect(r.text).toBe('---\r\nid: A\r\nstatus:   approved   # 要レビュー\r\ntitle: "t"\r\n---\r\n本文');
    expect(r.line).toBe(3);
    expect(setStatus("---\nstatus: 'draft'\n---\n").text).toBe("---\nstatus: 'approved'\n---\n");
    expect(setStatus('---\nstatus: review\n---\n', 'draft').text).toBe('---\nstatus: draft\n---\n');
  });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const DOC = '---\nid: ORDER\nstatus: review\n---\n\n# 注文\n';

async function setup(pull: Partial<Parameters<typeof fakeGitHubState>[0]> & { headRepo?: string } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-stc-'));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'docs/a.md'), DOC);
  await fs.writeFile(path.join(dir, 'docs/b.md'), DOC.replace('ORDER', 'B'));
  await fs.writeFile(path.join(dir, 'docs/done.md'), DOC.replace('review', 'approved'));
  const state = fakeGitHubState({
    pulls: { 'acme/order-app': [{ number: 12, title: 't', headSha: 'h1', headRef: 'feature/x', baseRef: 'main', headRepo: pull.headRepo }] },
  });
  const f = fakeGitHub(state);
  const tokens = new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: state.token }, fetch: f });
  const committer = new StatusCommitter(new GitHubClient(tokens, { fetch: f }));
  const ws = { headSha: 'h1', dir, pr: { headRepo: pull.headRepo ?? 'acme/order-app', headRef: 'feature/x' } };
  return { state, committer, ws };
}

describe('StatusCommitter', () => {
  it('[BD-GHREV-APPROVE-P002] [BD-GHREV-APPROVE-T004] [BD-GHREV-APPROVE-T005] [BD-GHREV-APPROVE-T006] ref → blobs → tree → commit → non-force PATCH (only documents that change)', async () => {
    const { state, committer, ws } = await setup({ headRepo: 'fork/order-app' });
    state.pulls['fork/order-app'] = state.pulls['acme/order-app'];
    const r = await committer.commit(ws, ['docs/a.md', 'docs/b.md', 'docs/done.md']);
    expect(r?.paths).toEqual(['docs/a.md', 'docs/b.md']);
    const writes = state.requests.map((q) => `${q.method} ${q.path}`);
    expect(writes).toEqual([
      'GET /repos/fork/order-app/git/ref/heads/feature/x',
      'POST /repos/fork/order-app/git/blobs',
      'POST /repos/fork/order-app/git/blobs',
      'GET /repos/fork/order-app/git/commits/h1',
      'POST /repos/fork/order-app/git/trees',
      'POST /repos/fork/order-app/git/commits',
      'PATCH /repos/fork/order-app/git/refs/heads/feature/x',
    ]);
    const body = (suffix: string) => state.requests.find((q) => q.path.endsWith(suffix))!.body;
    expect(body('/git/blobs').content).toContain('status: approved');
    expect(body('/git/trees').tree.map((t: { path: string }) => t.path)).toEqual(['docs/a.md', 'docs/b.md']);
    expect(body('/git/commits')).toMatchObject({ parents: ['h1'], message: 'docs: approve a.md b.md (ddv)' });
    expect(state.requests.at(-1)!.body).toMatchObject({ sha: r!.sha, force: false });
    expect(state.pulls['fork/order-app'][0].headSha).toBe(r!.sha);
  });

  it('nothing to change → no commit', async () => {
    const { state, committer, ws } = await setup();
    expect(await committer.commit(ws, ['docs/done.md'])).toBeNull();
    expect(state.requests).toEqual([]);
  });

  it('[BD-GHREV-APPROVE-P003] [BD-GHREV-APPROVE-T007] head moved on GitHub → stale, nothing written', async () => {
    const { state, committer, ws } = await setup();
    state.pulls['acme/order-app'][0].headSha = 'h2';
    await expect(committer.commit(ws, ['docs/a.md'])).rejects.toMatchObject({ code: 'stale', status: 409 });
    expect(state.requests.map((q) => q.method)).toEqual(['GET']);
  });

  it('[BD-GHREV-APPROVE-P003] [BD-GHREV-APPROVE-T007] PATCH 422 (not a fast-forward) → stale', async () => {
    const { state, committer, ws } = await setup();
    state.failOn.push({ match: 'PATCH /repos/acme/order-app/git/refs/heads/feature/x', status: 422, message: 'Update is not a fast forward' });
    const err = await committer.commit(ws, ['docs/a.md']).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewError);
    expect(err.code).toBe('stale');
  });
});
