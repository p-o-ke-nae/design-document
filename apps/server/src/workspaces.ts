import { EventEmitter } from 'node:events';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { GitHubError, type GitHubClient } from '@ddv/github';
import type { ServerContext } from './app.ts';
import type { GitCache } from './git.ts';

export type WsState = 'None' | 'Fetching' | 'Ready' | 'Stale' | 'Error';
/** Events of the workspace state diagram (BD-GHREV-WS): 開く・取得完了・取得失敗・再試行・更新検知・最新化・閉じる. */
export type WsEvent = 'open' | 'done' | 'fail' | 'retry' | 'detect' | 'refresh' | 'close';

const WS_TRANSITIONS: Record<WsState, Partial<Record<WsEvent, WsState>>> = {
  None: { open: 'Fetching' },
  Fetching: { done: 'Ready', fail: 'Error' },
  Ready: { detect: 'Stale', refresh: 'Fetching', close: 'None' },
  Stale: { refresh: 'Fetching', close: 'None' },
  Error: { retry: 'Fetching', close: 'None' },
};

/** Next state, or null when the event is not in the diagram for that state (ignored / rejected). */
export function nextWsState(state: WsState, event: WsEvent): WsState | null {
  return WS_TRANSITIONS[state][event] ?? null;
}
export type FetchStep = 'pr' | 'clone' | 'fetch' | 'worktree' | 'ready' | 'error';

export interface OpenRequest {
  repo?: unknown;
  pr?: unknown;
  ref?: unknown;
}

export interface ParsedOpen {
  id: string;
  owner: string;
  repo: string;
  pr?: number;
  ref?: string;
  /** Directory / id suffix: `pr-12` or `ref-<name with / as ~~>`. */
  name: string;
}

export class OpenRequestError extends Error {
  readonly status = 400;
  constructor(
    readonly code: 'repo' | 'target' | 'pr' | 'ref',
    message: string,
  ) {
    super(message);
  }
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Mirrors `git check-ref-format --branch` plus the extra rules for use in args and paths. */
export function isSafeRefName(ref: string): boolean {
  if (!ref || ref.length > 200) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref === '@') return false;
  if (ref.includes('..') || ref.includes('~') || ref.includes('//') || ref.includes('@{')) return false;
  if (/[\x00-\x20\x7f^:?*[\\<>"|]/.test(ref)) return false;
  return ref.split('/').every((c) => c.length > 0 && !c.startsWith('.') && !c.endsWith('.lock'));
}

export function workspaceId(owner: string, repo: string, name: string): string {
  return `gh~${owner}~${repo}~${name}`;
}

/** Validates `owner/repo`. */
export function parseRepo(full: unknown): { owner: string; repo: string } {
  const repoFull = typeof full === 'string' ? full.trim() : '';
  const [owner, repo, ...rest] = repoFull.split('/');
  if (rest.length || !owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') {
    throw new OpenRequestError('repo', 'owner/repo の形式で入力してください');
  }
  return { owner, repo };
}

/** Validates `{ repo, pr? , ref? }` (OPENREQ) and derives the workspace id. */
export function parseOpenRequest(body: OpenRequest): ParsedOpen {
  const { owner, repo } = parseRepo(body.repo);
  const hasPr = body.pr !== undefined && body.pr !== null && body.pr !== '';
  const hasRef = body.ref !== undefined && body.ref !== null && body.ref !== '';
  if (hasPr === hasRef) throw new OpenRequestError('target', 'PR 番号か branch・tag 名のどちらかを指定してください');
  if (hasPr) {
    const n = typeof body.pr === 'number' ? body.pr : typeof body.pr === 'string' && /^\d+$/.test(body.pr.trim()) ? Number(body.pr.trim()) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) throw new OpenRequestError('pr', 'PR 番号を入力してください');
    const name = `pr-${n}`;
    return { id: workspaceId(owner, repo, name), owner, repo, pr: n, name };
  }
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (!isSafeRefName(ref)) throw new OpenRequestError('ref', 'branch・tag 名を確認してください');
  const name = `ref-${ref.replaceAll('/', '~~')}`;
  return { id: workspaceId(owner, repo, name), owner, repo, ref, name };
}

export function parseWorkspaceId(id: string): ParsedOpen | null {
  const m = /^gh~([^~]+)~([^~]+)~(pr-(\d+)|ref-(.+))$/.exec(id);
  if (!m) return null;
  try {
    return parseOpenRequest({ repo: `${m[1]}/${m[2]}`, ...(m[4] ? { pr: Number(m[4]) } : { ref: m[5].replaceAll('~~', '/') }) });
  } catch {
    return null;
  }
}

export interface PullInfo {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  htmlUrl: string;
  author: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  headRepo: string;
  canPush: boolean;
}

interface RawPull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  html_url: string;
  user?: { login?: string };
  head: { sha: string; ref: string; repo?: { full_name?: string; permissions?: { push?: boolean } } | null };
  base: { ref: string };
  maintainer_can_modify?: boolean;
}

export function toPullInfo(p: RawPull): PullInfo {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    merged: Boolean(p.merged ?? p.merged_at),
    htmlUrl: p.html_url,
    author: p.user?.login ?? '',
    baseRef: p.base.ref,
    headRef: p.head.ref,
    headSha: p.head.sha,
    headRepo: p.head.repo?.full_name ?? '',
    canPush: Boolean(p.head.repo?.permissions?.push || p.maintainer_can_modify),
  };
}

export type WorkspaceEvent =
  | { type: 'progress'; step: FetchStep; message?: string }
  | { type: 'ready'; headSha: string; baseRef?: string; mergeBase?: string }
  | { type: 'stale'; headSha: string };

export interface Workspace {
  id: string;
  target: ParsedOpen;
  state: WsState;
  step?: FetchStep;
  error?: string;
  trusted: boolean;
  pr?: PullInfo;
  headSha: string;
  baseRef?: string;
  mergeBase?: string;
  remoteHeadSha?: string;
  dir: string;
  ctx?: ServerContext;
  openedAt: string;
  events: EventEmitter;
  /** Increments whenever ctx is replaced (route caches key on it). */
  generation: number;
}

export interface WorkspaceInfo {
  id: string;
  repo: string;
  kind: 'pr' | 'ref';
  pr?: number;
  ref?: string;
  title?: string;
  state: WsState;
  step?: FetchStep;
  error?: string;
  trusted: boolean;
  headSha: string;
  remoteHeadSha?: string;
  openedAt: string;
}

interface StoredWorkspace {
  id: string;
  repo: string;
  pr?: number;
  ref?: string;
  trusted: boolean;
  headSha: string;
  baseRef?: string;
  mergeBase?: string;
  openedAt: string;
}

/** `DDV_HOME/workspaces.json` (no token, no PR body). Writes go through a temp file + rename. */
export class WorkspaceStore {
  readonly file: string;
  constructor(home: string) {
    this.file = path.join(home, 'workspaces.json');
  }

  async load(): Promise<StoredWorkspace[]> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8')) as { version?: number; workspaces?: StoredWorkspace[] };
      return data.version === 1 && Array.isArray(data.workspaces) ? data.workspaces : [];
    } catch {
      return [];
    }
  }

  async save(list: StoredWorkspace[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, workspaces: list }, null, 2) + '\n');
    await fs.rename(tmp, this.file);
  }
}

export interface CleanResult {
  worktrees: string[];
  clones: string[];
  /** Clones kept because saved workspaces still use them. */
  kept: string[];
}

/**
 * `ddv gh clean`: removes worktrees that are not in workspaces.json; with `repo`, also removes that clone
 * (only when no saved workspace uses it).
 */
export async function cleanWorkspaces(home: string, git: GitCache, repo?: string): Promise<CleanResult> {
  const saved = new Set((await new WorkspaceStore(home).load()).map((s) => s.id));
  const result: CleanResult = { worktrees: [], clones: [], kept: [] };
  const target = repo ? parseRepo(repo) : null;
  const ls = async (d: string) => (await fs.readdir(d, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
  const repos: { owner: string; repo: string }[] = [];
  if (target) repos.push(target);
  else {
    const seen = new Set<string>();
    for (const owner of await ls(path.join(home, 'repos'))) {
      for (const r of await ls(path.join(home, 'repos', owner))) if (r.endsWith('.git')) seen.add(`${owner}/${r.slice(0, -4)}`);
    }
    for (const owner of await ls(path.join(home, 'worktrees'))) for (const r of await ls(path.join(home, 'worktrees', owner))) seen.add(`${owner}/${r}`);
    for (const k of seen) {
      const [owner, r] = k.split('/');
      repos.push({ owner, repo: r });
    }
  }
  for (const { owner, repo: r } of repos) {
    let inUse = false;
    for (const name of await ls(path.join(home, 'worktrees', owner, r))) {
      if (saved.has(workspaceId(owner, r, name))) {
        inUse = true;
        continue;
      }
      const dir = git.worktreeDir(owner, r, name);
      await git.removeWorktree(owner, r, dir);
      result.worktrees.push(dir);
    }
    if (!target) continue;
    if (inUse) result.kept.push(git.repoDir(owner, r));
    else if (existsSync(git.repoDir(owner, r))) {
      await fs.rm(git.repoDir(owner, r), { recursive: true, force: true });
      await fs.rm(path.join(home, 'worktrees', owner, r), { recursive: true, force: true });
      result.clones.push(git.repoDir(owner, r));
    }
  }
  return result;
}

export class WorkspaceError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: 'not-found' | 'not-ready' | 'fetching',
    message: string,
  ) {
    super(message);
  }
}

export interface WorkspaceManagerOptions {
  home: string;
  github: GitHubClient;
  git: GitCache;
  createContext: (dir: string) => Promise<ServerContext>;
  /** DDV_GITHUB_POLL seconds (0 disables). */
  pollSeconds?: number;
  now?: () => number;
}

export const CHECK_THROTTLE_MS = 30_000;

/** Owns the GitHub workspaces: open → fetchJob → Ready / Error, refresh, update detection, trust, close. */
export class WorkspaceManager {
  private readonly items = new Map<string, Workspace>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly lastCheck = new Map<string, { at: number; stale: boolean }>();
  private readonly store: WorkspaceStore;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: WorkspaceManagerOptions) {
    this.store = new WorkspaceStore(opts.home);
    this.now = opts.now ?? Date.now;
  }

  get git(): GitCache {
    return this.opts.git;
  }

  get github(): GitHubClient {
    return this.opts.github;
  }

  get home(): string {
    return this.opts.home;
  }

  /** Restores saved workspaces whose worktree still exists (as Ready, with the saved head) and starts polling. */
  async init(): Promise<void> {
    for (const s of await this.store.load()) {
      const target = parseWorkspaceId(s.id);
      if (!target || this.items.has(s.id)) continue;
      const dir = this.opts.git.worktreeDir(target.owner, target.repo, target.name);
      if (!existsSync(path.join(dir, '.git'))) continue;
      const ws = this.create(target, s.openedAt);
      Object.assign(ws, { trusted: s.trusted, headSha: s.headSha, baseRef: s.baseRef, mergeBase: s.mergeBase, dir });
      try {
        ws.ctx = await this.opts.createContext(dir);
        ws.ctx.checkDeps = true;
        ws.generation++;
        ws.state = 'Ready';
      } catch (e) {
        ws.state = 'Error';
        ws.error = (e as Error).message;
      }
    }
    const sec = this.opts.pollSeconds ?? 60;
    if (sec > 0) {
      this.timer = setInterval(() => void this.poll(), sec * 1000);
      this.timer.unref();
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const ws of this.items.values()) ws.ctx?.close();
  }

  list(): WorkspaceInfo[] {
    return [...this.items.values()].map((w) => this.info(w));
  }

  get(id: string): Workspace | undefined {
    return this.items.get(id);
  }

  info(w: Workspace): WorkspaceInfo {
    return {
      id: w.id,
      repo: `${w.target.owner}/${w.target.repo}`,
      kind: w.target.pr ? 'pr' : 'ref',
      ...(w.target.pr ? { pr: w.target.pr } : { ref: w.target.ref }),
      title: w.pr?.title,
      state: w.state,
      step: w.step,
      error: w.error,
      trusted: w.trusted,
      headSha: w.headSha,
      remoteHeadSha: w.remoteHeadSha,
      openedAt: w.openedAt,
    };
  }

  /** Opens a new workspace (fetching continues in the background). An already-open one is returned as is (開く is not a transition from other states). */
  open(body: OpenRequest): Workspace {
    const target = parseOpenRequest(body);
    const existing = this.items.get(target.id);
    if (existing) return existing;
    const ws = this.create(target, new Date(this.now()).toISOString());
    void this.start(ws, 'open');
    return ws;
  }

  /** 最新化 (Ready / Stale) or 再試行 (Error): re-runs fetchJob, reusing the clone and worktree. While fetching, returns the running job. */
  refresh(id: string): Promise<void> {
    const ws = this.require(id);
    return this.start(ws, ws.state === 'Error' ? 'retry' : 'refresh');
  }

  /** Waits for the running fetch job, if any. */
  async settled(id: string): Promise<void> {
    await this.jobs.get(id);
  }

  async trust(id: string): Promise<WorkspaceInfo> {
    const ws = this.require(id);
    ws.trusted = true;
    await this.persist();
    return this.info(ws);
  }

  async close(id: string): Promise<void> {
    const ws = this.require(id);
    if (!nextWsState(ws.state, 'close')) throw new WorkspaceError(409, 'fetching', '取得中は閉じられません');
    ws.ctx?.close();
    ws.ctx = undefined;
    ws.state = 'None';
    this.items.delete(id);
    this.lastCheck.delete(id);
    await this.opts.git.removeWorktree(ws.target.owner, ws.target.repo, ws.dir);
    await this.persist();
  }

  /** Context for routing: only Ready / Stale workspaces serve the existing API. */
  context(id: string): { ws: Workspace; ctx: ServerContext } {
    const ws = this.items.get(id);
    if (!ws) throw new WorkspaceError(404, 'not-found', `ワークスペースがありません: ${id}`);
    if ((ws.state !== 'Ready' && ws.state !== 'Stale') || !ws.ctx) throw new WorkspaceError(409, 'not-ready', `ワークスペースの準備ができていません（${ws.state}）`);
    return { ws, ctx: ws.ctx };
  }

  /** Compares the PR head on GitHub with the worktree; marks Stale when it moved. `force` skips the 30 s throttle. */
  async checkHead(id: string, force = false): Promise<boolean> {
    const ws = this.require(id);
    if (!ws.target.pr) return false;
    const last = this.lastCheck.get(id);
    if (!force && last && this.now() - last.at < CHECK_THROTTLE_MS) return last.stale;
    const pr = toPullInfo(await this.opts.github.rest<RawPull>('GET', `/repos/${ws.target.owner}/${ws.target.repo}/pulls/${ws.target.pr}`));
    ws.pr = pr;
    ws.remoteHeadSha = pr.headSha;
    const stale = Boolean(ws.headSha) && pr.headSha !== ws.headSha;
    const next = stale ? nextWsState(ws.state, 'detect') : null;
    if (next) {
      ws.state = next;
      this.emit(ws, { type: 'stale', headSha: pr.headSha });
    }
    this.lastCheck.set(id, { at: this.now(), stale: ws.state === 'Stale' });
    return ws.state === 'Stale';
  }

  /** PR information for the PR bar (fetched on demand after a restore). */
  async pull(id: string): Promise<PullInfo | undefined> {
    const ws = this.require(id);
    if (ws.target.pr && !ws.pr) await this.checkHead(id, true);
    return ws.pr;
  }

  private async poll(): Promise<void> {
    for (const ws of this.items.values()) {
      if (ws.state === 'Ready' && ws.target.pr) await this.checkHead(ws.id, true).catch(() => undefined);
    }
  }

  private create(target: ParsedOpen, openedAt: string): Workspace {
    const ws: Workspace = {
      id: target.id,
      target,
      state: 'None',
      trusted: false,
      headSha: '',
      dir: this.opts.git.worktreeDir(target.owner, target.repo, target.name),
      openedAt,
      events: new EventEmitter(),
      generation: 0,
    };
    ws.events.setMaxListeners(100);
    this.items.set(ws.id, ws);
    return ws;
  }

  private require(id: string): Workspace {
    const ws = this.items.get(id);
    if (!ws) throw new WorkspaceError(404, 'not-found', `ワークスペースがありません: ${id}`);
    return ws;
  }

  private emit(ws: Workspace, ev: WorkspaceEvent): void {
    ws.events.emit('event', ev);
  }

  private start(ws: Workspace, event: WsEvent): Promise<void> {
    const running = this.jobs.get(ws.id);
    if (running) return running;
    const next = nextWsState(ws.state, event);
    if (next !== 'Fetching') return Promise.resolve();
    ws.state = next;
    ws.error = undefined;
    const job = this.fetchJob(ws).finally(() => this.jobs.delete(ws.id));
    this.jobs.set(ws.id, job);
    return job;
  }

  private step(ws: Workspace, step: FetchStep): void {
    ws.step = step;
    this.emit(ws, { type: 'progress', step });
  }

  private fail(ws: Workspace, message: string): void {
    if (nextWsState(ws.state, 'fail') !== 'Error') return;
    ws.state = 'Error';
    ws.step = 'error';
    ws.error = message;
    this.emit(ws, { type: 'progress', step: 'error', message });
  }

  /** FETCH: PR info / ref → ensureClone → fetch → worktree → mergeBase + createContext → Ready. */
  private async fetchJob(ws: Workspace): Promise<void> {
    const { owner, repo, pr, ref } = ws.target;
    const git = this.opts.git;
    // Let the caller subscribe to events before the first step is emitted.
    await Promise.resolve();
    let headSha: string;
    let refspecs: string[][];
    let baseRef: string | undefined;
    try {
      this.step(ws, 'pr');
      if (pr) {
        const info = toPullInfo(await this.opts.github.rest<RawPull>('GET', `/repos/${owner}/${repo}/pulls/${pr}`));
        ws.pr = info;
        headSha = info.headSha;
        baseRef = info.baseRef;
        refspecs = [[`+refs/pull/${pr}/head:refs/ddv/pr/${pr}`, `+refs/heads/${info.baseRef}:refs/ddv/base/${info.baseRef}`]];
      } else {
        const c = await this.opts.github.rest<{ sha: string }>('GET', `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref!)}`);
        headSha = c.sha;
        refspecs = [[`+refs/heads/${ref}:refs/ddv/ref/${ref}`], [`+refs/tags/${ref}:refs/ddv/ref/${ref}`]];
      }
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'notFound') return this.fail(ws, pr ? `PR #${pr} が見つかりません（${owner}/${repo}）` : `branch・tag「${ref}」が見つかりません（${owner}/${repo}）`);
      return this.fail(ws, (e as Error).message);
    }
    try {
      this.step(ws, 'clone');
      await git.ensureClone(owner, repo);
    } catch (e) {
      return this.fail(ws, `clone に失敗しました: ${(e as Error).message}`);
    }
    try {
      this.step(ws, 'fetch');
      let lastErr: Error | null = null;
      for (const specs of refspecs) {
        try {
          await git.fetch(owner, repo, specs);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e as Error;
        }
      }
      if (lastErr && !(await git.hasCommit(owner, repo, headSha))) throw lastErr;
      if (!(await git.hasCommit(owner, repo, headSha))) throw new Error(`${headSha.slice(0, 7)} を取得できませんでした`);
    } catch (e) {
      return this.fail(ws, `fetch に失敗しました: ${(e as Error).message}`);
    }
    try {
      this.step(ws, 'worktree');
      if (existsSync(path.join(ws.dir, '.git'))) await git.checkout(owner, repo, ws.dir, headSha);
      else ws.dir = await git.addWorktree(owner, repo, ws.target.name, headSha);
      let mergeBase: string | undefined;
      if (pr && baseRef) {
        const baseSha = await git.revParse(owner, repo, `refs/ddv/base/${baseRef}`);
        if (baseSha) mergeBase = await git.mergeBase(owner, repo, baseSha, headSha).catch(() => undefined);
      }
      const ctx = await this.opts.createContext(ws.dir);
      ctx.checkDeps = true;
      if (nextWsState(ws.state, 'done') !== 'Ready') {
        ctx.close();
        return;
      }
      ws.ctx?.close();
      ws.ctx = ctx;
      ws.generation++;
      Object.assign(ws, { headSha, baseRef, mergeBase, remoteHeadSha: headSha, state: 'Ready' as WsState, step: 'ready' as FetchStep });
      this.lastCheck.delete(ws.id);
      this.emit(ws, { type: 'ready', headSha, baseRef, mergeBase });
      await this.persist();
    } catch (e) {
      return this.fail(ws, (e as Error).message);
    }
  }

  private async persist(): Promise<void> {
    const list: StoredWorkspace[] = [...this.items.values()]
      .filter((w) => w.headSha)
      .map((w) => ({
        id: w.id,
        repo: `${w.target.owner}/${w.target.repo}`,
        ...(w.target.pr ? { pr: w.target.pr } : { ref: w.target.ref }),
        trusted: w.trusted,
        headSha: w.headSha,
        baseRef: w.baseRef,
        mergeBase: w.mergeBase,
        openedAt: w.openedAt,
      }));
    await this.store.save(list);
  }
}
