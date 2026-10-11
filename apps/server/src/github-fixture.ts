import { execFileSync } from 'node:child_process';
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
}

export interface FakeGitHubState {
  login: string;
  token: string;
  pulls: Record<string, FakePull[]>;
  refs: Record<string, Record<string, string>>;
  calls: string[];
}

export function fakeGitHubState(init: Partial<FakeGitHubState> = {}): FakeGitHubState {
  return { login: 'alice', token: 'ghp_test_token', pulls: {}, refs: {}, calls: [], ...init };
}

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
    head: { sha: p.headSha, ref: p.headRef, repo: { full_name: repo, permissions: { push: p.canPush ?? true } } },
    base: { ref: p.baseRef, repo: { full_name: repo } },
    maintainer_can_modify: false,
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
    return j(404, { message: 'Not Found' });
  };
}
