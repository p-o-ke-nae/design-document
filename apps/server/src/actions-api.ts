import type { Context, Hono } from 'hono';
import type { GitHubClient } from '@ddv/github';
import {
  ActionsError,
  ActionsService,
  ACTIONS_MESSAGES,
  systemEnv,
  type ActionsEvent,
  type ActionsStatus,
  type Clock,
  type Random,
  type RepoRef,
  type TrackerIntervals,
  type TrackerTimers,
} from '@ddv/services';
import { mimeOf, type ServerContext } from './app.ts';
import { LocalActionsTarget, WorkspaceActionsTarget } from './actions-target.ts';
import { initWorkflow, TemplateMissingError } from './ci/workflow-init.ts';
import { RepoRemote } from './repo-remote.ts';
import type { Workspace } from './workspaces.ts';

/** Stop the trackers this long after the last SSE subscriber left (local workspace). */
export const IDLE_STOP_MS = 60_000;

export type ActionsBinding =
  | { kind: 'local'; root: string }
  | { kind: 'workspace'; ws: () => Workspace; onApproved?: () => Promise<unknown> | void };

export interface ActionsHostDeps {
  client: GitHubClient;
  hasToken: () => Promise<boolean>;
  remote?: RepoRemote;
  intervals?: Partial<TrackerIntervals>;
  timers?: TrackerTimers;
  clock?: Clock;
  random?: Random;
  log?: (line: string) => void;
}

const HIDDEN: ActionsStatus = { state: 'hidden', reason: '', workflow: null, canInit: false };

/** The Actions feature of one ServerContext: the ActionsService of its GitHub remote and the `actions` SSE subscribers. */
export class ActionsHost {
  private current: { key: string; service: ActionsService; off: () => void } | null = null;
  private readonly listeners = new Set<(e: ActionsEvent) => void>();
  private idle: NodeJS.Timeout | null = null;
  private readonly remote: RepoRemote;

  constructor(
    private readonly ctx: ServerContext,
    readonly binding: ActionsBinding,
    private readonly deps: ActionsHostDeps,
  ) {
    this.remote = deps.remote ?? new RepoRemote();
  }

  async repo(): Promise<RepoRef | null> {
    if (this.binding.kind === 'workspace') {
      const t = this.binding.ws().target;
      return { owner: t.owner, repo: t.repo };
    }
    return this.remote.read(this.binding.root);
  }

  /** null = no GitHub remote (the local workspace): nothing touches GitHub. */
  async service(): Promise<ActionsService | null> {
    const repo = await this.repo();
    if (!repo) return null;
    const key = `${repo.owner}/${repo.repo}`;
    if (this.current?.key === key) return this.current.service;
    this.current?.off();
    this.current?.service.stopAll();
    const b = this.binding;
    const env = systemEnv;
    const service = new ActionsService({
      client: this.deps.client,
      repo,
      targets: b.kind === 'local' ? new LocalActionsTarget(b.root, repo, this.deps.client) : new WorkspaceActionsTarget(b.ws, repo),
      history: this.ctx.history,
      clock: this.deps.clock ?? env.clock,
      random: this.deps.random ?? env.random,
      hasToken: this.deps.hasToken,
      edition: 'local',
      canInit: b.kind === 'local',
      getConfig: () => this.ctx.config,
      timers: this.deps.timers,
      intervals: this.deps.intervals,
      log: this.deps.log ?? ((l) => console.warn(l)),
      onApproved: b.kind === 'workspace' ? () => b.onApproved?.() as Promise<void> | void : undefined,
    });
    const off = service.onEvent((e) => {
      for (const l of this.listeners) l(e);
    });
    this.current = { key, service, off };
    return service;
  }

  /** An `actions` SSE subscriber: replays the latest update of every tracker first. */
  subscribe(listener: (e: ActionsEvent) => void): () => void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    for (const u of this.current?.service.replay() ?? []) listener(u);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.binding.kind === 'local') {
        this.idle = setTimeout(() => {
          this.idle = null;
          if (this.listeners.size === 0) this.current?.service.stopAll();
        }, IDLE_STOP_MS);
        this.idle.unref?.();
      }
    };
  }

  dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    this.current?.off();
    this.current?.service.stopAll();
    this.current = null;
  }
}

const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
  const b = (await c.req.json().catch(() => ({}))) as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};

/**
 * The Actions API under `base` (`/api/actions` or `/api/w/:ws/actions`; actions-run.md「API」).
 * `host` returns null when there is no workspace (then `fallback` answers).
 */
export function registerActionsRoutes(app: Hono, base: string, host: (c: Context) => ActionsHost | null, fallback: (c: Context) => Response | Promise<Response>): void {
  const withService = async (c: Context, fn: (s: ActionsService, h: ActionsHost) => Promise<Response>): Promise<Response> => {
    const h = host(c);
    if (!h) return fallback(c);
    const s = await h.service();
    if (!s) throw new ActionsError(404, 'no-remote', ACTIONS_MESSAGES.noRemote);
    return fn(s, h);
  };

  app.get(base, async (c) => {
    const h = host(c);
    if (!h) return fallback(c);
    const s = await h.service();
    return c.json(s ? await s.status(c.req.query('refresh') === '1') : HIDDEN);
  });

  app.get(`${base}/runs`, (c) => withService(c, async (s) => c.json(await s.runs())));

  app.post(`${base}/runs`, (c) =>
    withService(c, async (s) => {
      const b = await bodyOf(c);
      return c.json({ request: await s.dispatch({ ids: b.ids, runner: b.runner }) }, 202);
    }),
  );

  app.get(`${base}/runs/:id`, (c) => withService(c, async (s) => c.json(await s.run(c.req.param('id')))));

  app.get(`${base}/runs/:id/files/*`, (c) =>
    withService(c, async (s) => {
      const id = c.req.param('id');
      const marker = `/runs/${encodeURIComponent(id)}/files/`;
      const raw = c.req.path.slice(c.req.path.indexOf(marker) + marker.length);
      let rel: string;
      try {
        rel = raw.split('/').map(decodeURIComponent).join('/');
      } catch {
        rel = raw;
      }
      const bytes = await s.file(id, rel);
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': mimeOf(rel), 'cache-control': 'private, max-age=86400' } });
    }),
  );

  app.post(`${base}/runs/:id/approve`, (c) =>
    withService(c, async (s) => {
      const b = await bodyOf(c);
      return c.json({ request: await s.approve(c.req.param('id'), b.ids) }, 202);
    }),
  );

  app.post(`${base}/init`, async (c) => {
    const h = host(c);
    if (!h) return fallback(c);
    if (h.binding.kind !== 'local') return c.json({ error: 'ワークフローの配置は手元のワークスペースだけでできます', code: 'local-only' }, 404);
    const b = await bodyOf(c);
    if (b.force !== undefined && typeof b.force !== 'boolean') return c.json({ error: 'force は真偽値で指定してください', code: 'invalid-request' }, 400);
    try {
      const r = await initWorkflow(h.binding.root, { force: b.force === true });
      (await h.service())?.invalidateStatus();
      if (r.status === 'differs') return c.json({ error: '既存のファイルと内容が異なります。上書きするには --force を付けてください', code: 'workflow-differs', diff: r.diff, path: r.path }, 409);
      return c.json({ status: r.status, path: r.path }, r.status === 'created' ? 201 : 200);
    } catch (e) {
      if (e instanceof TemplateMissingError) return c.json({ error: e.message, code: e.code }, 500);
      throw e;
    }
  });
}
