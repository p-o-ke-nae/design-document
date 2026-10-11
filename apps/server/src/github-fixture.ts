import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Test helpers: a local upstream git repository and an in-memory GitHub API (no network). */

export interface Upstream {
  dir: string;
  git(...args: string[]): string;
  commit(branch: string, files: Record<string, string>, message?: string): string;
  setPull(n: number, sha: string): void;
}

const DOC = (title: string, body: string) => `---\nid: SAMPLE\nkind: basic\nstatus: review\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;

export async function createUpstream(root?: string): Promise<Upstream> {
  const dir = path.join(root ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-up-'))), 'acme', 'order-app');
  await fs.mkdir(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'uploadpack.allowFilter', 'true');
  git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  const commit = (branch: string, files: Record<string, string>, message = 'update') => {
    const current = git('symbolic-ref', '--short', 'HEAD');
    if (current !== branch) {
      const exists = git('branch', '--list', branch);
      git('checkout', '-q', ...(exists ? [branch] : ['-b', branch]));
    }
    for (const [f, c] of Object.entries(files)) {
      const abs = path.join(dir, f);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, c);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
    const sha = git('rev-parse', 'HEAD');
    if (branch !== 'main') git('checkout', '-q', 'main');
    return sha;
  };
  commit('main', {
    'ddv.config.yaml': 'docsRoot: docs/design\nmocksRoot: docs/mocks\n',
    '.gitignore': '.ddv/runs/\n',
    'docs/design/basic/order.md': DOC('注文 基本設計', '## 概要\n\n注文を受け付ける。'),
  }, 'initial');
  return {
    dir,
    git,
    commit,
    setPull: (n, sha) => git('update-ref', `refs/pull/${n}/head`, sha),
  };
}

export interface FakePull {
  number: number;
  title: string;
  state?: 'open' | 'closed';
  merged?: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  canPush?: boolean;
  /** `owner/repo` of the head repository (a fork); defaults to the base repository. */
  headRepo?: string;
  maintainerCanModify?: boolean;
}

export interface FakeThread {
  id: string;
  path: string;
  line?: number | null;
  startLine?: number | null;
  side?: 'LEFT' | 'RIGHT';
  resolved?: boolean;
  outdated?: boolean;
  comments: { id: number; author: string; body: string; createdAt?: string }[];
}

export interface FakeReview {
  id?: number;
  user: { login: string };
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at?: string;
}

export interface FakeGitHubState {
  login: string;
  token: string;
  pulls: Record<string, FakePull[]>;
  refs: Record<string, Record<string, string>>;
  /** key: `owner/repo#N` */
  threads: Record<string, FakeThread[]>;
  /** key: `owner/repo#N` */
  reviews: Record<string, FakeReview[]>;
  calls: string[];
  /** Every request with its parsed JSON body (writes are asserted on these). */
  requests: { method: string; path: string; body?: any }[];
  /** Makes matching requests (`METHOD path` contains `match`) fail with `status`; `skip` lets the first N pass, `times` limits how often (default: always). */
  failOn: { match: string; status: number; message: string; errors?: string[]; skip?: number; times?: number }[];
  /** When set, commits made through the Git Data API are materialized in this upstream and the PR ref follows. */
  upstream?: Upstream;
  git: {
    blobs: Record<string, string>;
    trees: Record<string, { base: string; entries: { path: string; sha: string }[] }>;
    commits: Record<string, { tree: string; parents: string[]; message: string }>;
  };
  nextId: number;
}

export function fakeGitHubState(init: Partial<FakeGitHubState> = {}): FakeGitHubState {
  return {
    login: 'alice',
    token: 'ghp_test_token',
    pulls: {},
    refs: {},
    threads: {},
    reviews: {},
    calls: [],
    requests: [],
    failOn: [],
    git: { blobs: {}, trees: {}, commits: {} },
    nextId: 1000,
    ...init,
  };
}

/** GitHub rejects review comments on a file that is not in the PR diff ("could not be resolved"); checked when an upstream repository backs the fixture. */
function outsideDiff(state: FakeGitHubState, key: string, file: unknown): { message: string; errors: string[] } | null {
  const [repo, n] = key.split('#');
  const pr = (state.pulls[repo] ?? []).find((x) => x.number === Number(n));
  if (!state.upstream || !pr || typeof file !== 'string') return null;
  let changed: string[];
  try {
    changed = state.upstream.git('diff', '--name-only', `${pr.baseRef}...${pr.headSha}`).split('\n');
  } catch {
    return null;
  }
  return changed.includes(file) ? null : { message: 'Validation Failed', errors: [`Pull request review thread path could not be resolved: ${file}`] };
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

const REVIEW_STATE = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' } as const;

const j = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function pullJson(repo: string, p: FakePull) {
  return {
    number: p.number,
    title: p.title,
    state: p.state ?? 'open',
    merged: p.merged ?? false,
    html_url: `https://github.com/${repo}/pull/${p.number}`,
    user: { login: 'bob' },
    head: { sha: p.headSha, ref: p.headRef, repo: { full_name: p.headRepo ?? repo, permissions: { push: p.canPush ?? true } } },
    base: { ref: p.baseRef, repo: { full_name: repo } },
    maintainer_can_modify: p.maintainerCanModify ?? false,
  };
}

/** `fetch`-compatible handler for the GitHub REST endpoints used by the workspace feature. */
export function fakeGitHub(state: FakeGitHubState) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const p = url.pathname.replace(/^\/api\/v3/, '');
    state.calls.push(`${req.method} ${p}${url.search}`);
    if (req.headers.get('authorization') !== `Bearer ${state.token}`) return j(401, { message: 'Bad credentials' });
    let reqBody: any;
    if (req.method !== 'GET') reqBody = await req
      .clone()
      .json()
      .catch(() => undefined);
    if (p !== '/user') state.requests.push({ method: req.method, path: p, body: reqBody });
    const fail = state.failOn.find((f) => {
      if (!`${req.method} ${p}`.includes(f.match) || (f.times !== undefined && f.times <= 0)) return false;
      if (f.skip) {
        f.skip--;
        return false;
      }
      return true;
    });
    if (fail) {
      if (fail.times !== undefined) fail.times--;
      return j(fail.status, { message: fail.message, ...(fail.errors ? { errors: fail.errors } : {}) });
    }
    if (p === '/user') return j(200, { login: state.login });
    let m = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(p);
    if (m) return j(200, (state.pulls[`${m[1]}/${m[2]}`] ?? []).filter((x) => (x.state ?? 'open') === 'open').map((x) => pullJson(`${m![1]}/${m![2]}`, x)));
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(p);
    if (m) {
      const pr = (state.pulls[`${m[1]}/${m[2]}`] ?? []).find((x) => x.number === Number(m![3]));
      return pr ? j(200, pullJson(`${m[1]}/${m[2]}`, pr)) : j(404, { message: 'Not Found' });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/.exec(p);
    if (m) {
      const sha = state.refs[`${m[1]}/${m[2]}`]?.[decodeURIComponent(m[3])];
      return sha ? j(200, { sha }) : j(404, { message: 'No commit found for SHA' });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/.exec(p);
    if (m && req.method === 'GET') return j(200, state.reviews[`${m[1]}/${m[2]}#${m[3]}`] ?? []);
    if (m && req.method === 'POST') {
      const key = `${m[1]}/${m[2]}#${m[3]}`;
      const b = reqBody ?? {};
      for (const c of (b.comments ?? []) as any[]) {
        const bad = outsideDiff(state, key, c.path);
        if (bad) return j(422, bad);
      }
      const id = ++state.nextId;
      (state.reviews[key] ??= []).push({ id, user: { login: state.login }, state: REVIEW_STATE[b.event as keyof typeof REVIEW_STATE] ?? 'COMMENTED', submitted_at: new Date().toISOString() });
      for (const c of (b.comments ?? []) as any[]) {
        (state.threads[key] ??= []).push({
          id: `PRRT_${++state.nextId}`,
          path: c.path,
          line: c.line ?? null,
          startLine: c.start_line ?? null,
          side: c.side ?? 'RIGHT',
          comments: [{ id: ++state.nextId, author: state.login, body: c.body }],
        });
      }
      return j(200, { id, state: REVIEW_STATE[b.event as keyof typeof REVIEW_STATE] ?? 'COMMENTED', html_url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}#pullrequestreview-${id}` });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/comments$/.exec(p);
    if (m && req.method === 'POST') {
      const key = `${m[1]}/${m[2]}#${m[3]}`;
      const bad = outsideDiff(state, key, reqBody?.path);
      if (bad) return j(422, bad);
      const id = ++state.nextId;
      (state.threads[key] ??= []).push({ id: `PRRT_${++state.nextId}`, path: reqBody?.path, line: null, comments: [{ id, author: state.login, body: reqBody?.body ?? '' }] });
      return j(201, { id, html_url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}#discussion_r${id}` });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(p);
    if (m && req.method === 'POST') {
      const thread = (state.threads[`${m[1]}/${m[2]}#${m[3]}`] ?? []).find((t) => t.comments.some((c) => c.id === Number(m![4])));
      if (!thread) return j(404, { message: 'Not Found' });
      const id = ++state.nextId;
      const createdAt = new Date().toISOString();
      thread.comments.push({ id, author: state.login, body: reqBody?.body ?? '', createdAt });
      return j(201, { id, node_id: `PRRC_${id}`, user: { login: state.login }, body: reqBody?.body ?? '', created_at: createdAt, html_url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}#discussion_r${id}` });
    }
    const pullOfBranch = (repo: string, ref: string) => (state.pulls[repo] ?? []).find((x) => x.headRef === ref);
    m = /^\/repos\/([^/]+)\/([^/]+)\/git\/(ref|refs)\/heads\/(.+)$/.exec(p);
    if (m) {
      const repo = `${m[1]}/${m[2]}`;
      const ref = decodeURIComponent(m[4]);
      const pr = pullOfBranch(repo, ref);
      if (req.method === 'GET') {
        const sha = pr?.headSha ?? state.refs[repo]?.[ref];
        return sha ? j(200, { ref: `refs/heads/${ref}`, object: { sha } }) : j(404, { message: 'Not Found' });
      }
      if (req.method === 'PATCH' && pr) {
        const commit = state.git.commits[reqBody?.sha];
        if (!reqBody?.force && commit && commit.parents[0] !== pr.headSha) return j(422, { message: 'Update is not a fast forward' });
        pr.headSha = reqBody.sha;
        (state.refs[repo] ??= {})[ref] = reqBody.sha;
        state.upstream?.setPull(pr.number, reqBody.sha);
        return j(200, { ref: `refs/heads/${ref}`, object: { sha: reqBody.sha } });
      }
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/git\/(blobs|trees|commits)(?:\/([^/]+))?$/.exec(p);
    if (m) {
      const repo = `${m[1]}/${m[2]}`;
      if (m[3] === 'commits' && req.method === 'GET' && m[4]) {
        return j(200, { sha: m[4], tree: { sha: state.git.commits[m[4]]?.tree ?? `tree-${m[4]}` } });
      }
      if (req.method === 'POST' && m[3] === 'blobs') {
        const sha = sha1(`blob:${reqBody?.content}`);
        state.git.blobs[sha] = reqBody?.content ?? '';
        return j(201, { sha });
      }
      if (req.method === 'POST' && m[3] === 'trees') {
        const entries = ((reqBody?.tree ?? []) as { path: string; sha: string }[]).map(({ path: pth, sha }) => ({ path: pth, sha }));
        const sha = sha1(`tree:${reqBody?.base_tree}:${JSON.stringify(entries)}`);
        state.git.trees[sha] = { base: reqBody?.base_tree, entries };
        return j(201, { sha });
      }
      if (req.method === 'POST' && m[3] === 'commits') {
        const b = reqBody ?? {};
        const parent: string = b.parents?.[0];
        const pr = (state.pulls[repo] ?? []).find((x) => x.headSha === parent);
        let sha = sha1(`commit:${b.tree}:${parent}:${b.message}`);
        if (state.upstream && pr) {
          const files: Record<string, string> = {};
          for (const e of state.git.trees[b.tree]?.entries ?? []) files[e.path] = state.git.blobs[e.sha] ?? '';
          sha = state.upstream.commit(pr.headRef, files, b.message);
        }
        state.git.commits[sha] = { tree: b.tree, parents: b.parents ?? [], message: b.message ?? '' };
        return j(201, { sha });
      }
    }
    if (p === '/graphql' && req.method === 'POST') {
      const { query, variables } = (await req.json()) as { query: string; variables: Record<string, any> };
      if (query.includes('reviewThreads')) {
        const threads = state.threads[`${variables.owner}/${variables.repo}#${variables.pr}`] ?? [];
        return j(200, {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: threads.map((t) => ({
                    id: t.id,
                    isResolved: t.resolved ?? false,
                    isOutdated: t.outdated ?? false,
                    path: t.path,
                    line: t.line ?? null,
                    startLine: t.startLine ?? null,
                    diffSide: t.side ?? 'RIGHT',
                    comments: {
                      nodes: t.comments.map((c, i) => ({
                        id: `PRRC_${t.id}_${i}`,
                        databaseId: c.id,
                        author: { login: c.author },
                        body: c.body,
                        createdAt: c.createdAt ?? '2024-01-01T00:00:00Z',
                        url: `https://github.com/${variables.owner}/${variables.repo}/pull/${variables.pr}#discussion_r${c.id}`,
                      })),
                    },
                  })),
                },
              },
            },
          },
        });
      }
      if (query.includes('resolveReviewThread') || query.includes('unresolveReviewThread')) {
        const resolve = !query.includes('unresolveReviewThread');
        for (const list of Object.values(state.threads)) {
          const t = list.find((x) => x.id === variables.threadId);
          if (t) {
            t.resolved = resolve;
            return j(200, { data: { [resolve ? 'resolveReviewThread' : 'unresolveReviewThread']: { thread: { id: t.id, isResolved: resolve } } } });
          }
        }
        return j(200, { errors: [{ message: `Could not resolve to a node with the global id of '${variables.threadId}'` }] });
      }
      return j(200, { errors: [{ message: 'unsupported query' }] });
    }
    return j(404, { message: 'Not Found' });
  };
}
