/**
 * Stubbed GitHub for the Pages edition E2E: `api.github.com` and `raw.githubusercontent.com` answered by `page.route`
 * from examples/sample-app (the real GitHub is never called).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page, Request, Route } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLE = 'examples/sample-app';

export const OWNER = 'acme';
export const REPO = 'order-app';
/** Private: 404 without a PAT. */
export const PRIVATE_REPO = 'secret-app';
export const PR = 12;
export const PR_TITLE = '注文確認画面に戻るボタンを追加';
export const BASE_SHA = 'b'.repeat(40);
export const HEAD_SHA = 'a1b2c3d'.padEnd(40, '0');
export const NEW_HEAD_SHA = 'c'.repeat(40);
export const CHANGED_DOC = 'docs/design/basic/order.md';

/** Fine-grained PAT (write access through `permissions`). */
export const PAT_WRITE = 'github_pat_e2eWriteToken0123456789abcdefghijklmnop';
/** Classic PAT without scopes: viewing works, writes are missing `public_repo`. */
export const PAT_NOSCOPE = 'ghp_e2eNoScopeToken0123456789abcdefghijklmnop';
/** Rejected by GitHub (401). */
export const PAT_REVOKED = 'github_pat_e2eRevokedToken0123456789abcdefghijklmnop';
export const ALL_PATS = [PAT_WRITE, PAT_NOSCOPE, PAT_REVOKED];

interface Blob {
  path: string;
  sha: string;
  bytes: Buffer;
}

const blobSha = (b: Buffer) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');

function loadTree(): { base: Blob[]; head: Blob[] } {
  const files = execFileSync('git', ['ls-files', SAMPLE], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((f) => !f.includes('/.ddv/snapshots/'));
  const base = files.map((f) => {
    const bytes = readFileSync(path.join(ROOT, f));
    return { path: f.slice(SAMPLE.length + 1), sha: blobSha(bytes), bytes };
  });
  const head = base.map((b) => {
    if (b.path !== CHANGED_DOC) return b;
    const bytes = Buffer.concat([b.bytes, Buffer.from('\n## 戻るボタン\n\n確認画面から入力画面に戻れる。\n')]);
    return { ...b, sha: blobSha(bytes), bytes };
  });
  return { base, head };
}

const TREE = loadTree();

function dirsOf(files: Blob[]) {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].map((d) => ({ path: d, mode: '040000', type: 'tree', sha: blobSha(Buffer.from(d)) }));
}

export interface StubOptions {
  /** Answer 403 rate limit to anonymous requests of acme/order-app (取得失敗) until `heal()`. */
  rateLimited?: boolean;
  /** Hold the answers of matching api.github.com paths (e.g. to see 取得中, or to let an abandoned load finish late). */
  delays?: { path: RegExp; ms: number }[];
  /** Answer matching api.github.com paths with this status (取得失敗). */
  errors?: { path: RegExp; status: number }[];
}

export interface GitHubStub {
  /** Every request to api.github.com / raw.githubusercontent.com / codeload. */
  requests: { url: string; method: string; auth: string | null; host: string }[];
  /** Requests the stub did not know. */
  unhandled: string[];
  /** Moves the PR head (HeadWatcher → Stale). */
  setHead(sha: string): void;
  /** Lets the rate-limited answers go. */
  heal(): void;
}

const tokenOf = (req: Request) => req.headers()['authorization']?.replace(/^(token|Bearer)\s+/i, '') ?? null;

/** Stubs api.github.com / raw.githubusercontent.com / codeload.github.com for `page`. */
export async function stubGitHub(page: Page, opts: StubOptions = {}): Promise<GitHubStub> {
  const state = { rateLimited: opts.rateLimited ?? false, head: HEAD_SHA };
  const stub: GitHubStub = {
    requests: [],
    unhandled: [],
    setHead: (sha) => void (state.head = sha),
    heal: () => void (state.rateLimited = false),
  };
  const pull = () => ({
    number: PR,
    title: PR_TITLE,
    state: 'open',
    merged: false,
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${PR}`,
    user: { login: 'alice' },
    head: { sha: state.head, ref: 'feature/confirm-back', repo: { full_name: `${OWNER}/${REPO}` } },
    base: { sha: BASE_SHA, ref: 'main' },
    maintainer_can_modify: false,
  });

  // A late answer after the page closed is dropped.
  await page.route(/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com|codeload\.github\.com)\//, (route) => handle(route).catch(() => undefined));
  return stub;

  async function handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const token = tokenOf(req);
    stub.requests.push({ url: req.url(), method: req.method(), auth: req.headers()['authorization'] ?? null, host: url.host });
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });

    if (url.host === 'raw.githubusercontent.com') {
      const m = /^\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(url.pathname);
      const files = m?.[3] === BASE_SHA ? TREE.base : TREE.head;
      const f = m && m[1] === OWNER && m[2] === REPO ? files.find((b) => b.path === m[4].split('/').map(decodeURIComponent).join('/')) : undefined;
      if (!f) return route.fulfill({ status: 404, headers: cors, body: '404: Not Found' });
      return route.fulfill({ status: 200, headers: cors, body: f.bytes });
    }
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: {
          ...cors,
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '52',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          ...headers,
        },
        body: JSON.stringify(body),
      });
    if (url.host !== 'api.github.com') {
      stub.unhandled.push(req.url());
      return json(404, {});
    }
    const delay = opts.delays?.find((d) => d.path.test(url.pathname));
    if (delay) await new Promise((r) => setTimeout(r, delay.ms));
    const error = opts.errors?.find((d) => d.path.test(url.pathname));
    if (error) return json(error.status, { message: 'Server Error' });
    if (token === PAT_REVOKED) return json(401, { message: 'Bad credentials' });
    if (!token && state.rateLimited && url.pathname.startsWith(`/repos/${OWNER}/${REPO}`)) return json(403, { message: 'API rate limit exceeded for 203.0.113.1.' }, { 'x-ratelimit-remaining': '0' });
    const authed = token === PAT_WRITE || token === PAT_NOSCOPE;
    const extra: Record<string, string> = {
      ...(token === PAT_NOSCOPE ? { 'x-oauth-scopes': '' } : {}),
      ...(authed ? { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990' } : {}),
    };
    const ok = (body: unknown) => json(200, body, extra);

    const p = url.pathname;
    if (p === '/graphql') {
      if (!authed) return json(401, { message: 'This endpoint requires you to be authenticated.' });
      return ok({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    }
    const repoM = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!repoM) {
      stub.unhandled.push(`${req.method()} ${req.url()}`);
      return json(404, { message: 'Not Found' });
    }
    const [, owner, repo, rest = ''] = repoM;
    const isPrivate = repo === PRIVATE_REPO;
    if (owner !== OWNER || (repo !== REPO && repo !== PRIVATE_REPO) || (isPrivate && !authed)) return json(404, { message: 'Not Found' });
    const commits: Record<string, Blob[]> = { [BASE_SHA]: TREE.base, [HEAD_SHA]: TREE.head, [NEW_HEAD_SHA]: TREE.head };

    if (rest === '')
      return ok({
        full_name: `${owner}/${repo}`,
        default_branch: 'main',
        private: isPrivate,
        ...(authed ? { permissions: { admin: false, push: token === PAT_WRITE, pull: true } } : {}),
      });
    if (rest === `/pulls/${PR}`) return ok(pull());
    if (rest === `/pulls/${PR}/files`) return ok([{ filename: CHANGED_DOC, status: 'modified', additions: 4, deletions: 0, changes: 4, sha: TREE.head.find((b) => b.path === CHANGED_DOC)?.sha }]);
    if (rest.startsWith(`/pulls/${PR}/reviews`) || rest.startsWith(`/pulls/${PR}/comments`)) return ok([]);
    if (rest.startsWith('/compare/')) return ok({ merge_base_commit: { sha: BASE_SHA } });
    const cm = /^\/commits\/(.+)$/.exec(rest);
    if (cm) {
      const ref = decodeURIComponent(cm[1]);
      if (ref === 'main' || ref === 'v1.0') return ok({ sha: BASE_SHA });
      if (ref === 'feature/confirm-back') return ok({ sha: HEAD_SHA });
      return json(422, { message: `No commit found for SHA: ${ref}` });
    }
    const tm = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest);
    if (tm && commits[tm[1]]) {
      const files = commits[tm[1]];
      return ok({ sha: tm[1], truncated: false, tree: [...dirsOf(files), ...files.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha, size: b.bytes.length }))] });
    }
    const bm = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    const blob = bm ? [...TREE.base, ...TREE.head].find((x) => x.sha === bm[1]) : undefined;
    if (blob) return ok({ sha: blob.sha, size: blob.bytes.length, encoding: 'base64', content: blob.bytes.toString('base64') });
    stub.unhandled.push(`${req.method()} ${req.url()}`);
    return json(404, { message: 'Not Found' });
  }
}
