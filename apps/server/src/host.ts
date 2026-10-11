import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { GitHubError, type TokenResolver } from '@ddv/github';
import { createApp, mimeOf, type ServerContext } from './app.ts';
import { normalizePath } from '@ddv/core';
import { guard } from './guard.ts';
import { DiffService } from './pr-diff.ts';
import { ThreadService } from './threads.ts';
import { OpenRequestError, parseRepo, toPullInfo, WorkspaceError, type WorkspaceEvent, type WorkspaceManager } from './workspaces.ts';

export interface ServerAppOptions {
  /** The local workspace (`serve --repo`); absent when only GitHub workspaces are served. */
  local?: ServerContext;
  manager: WorkspaceManager;
  tokens: TokenResolver;
  /** Port the server listens on (Host check). */
  port: number;
  devOrigins?: string[];
  /** Built viewer (apps/web/dist) served for any other GET. */
  dist?: string;
}

/** POSTs that run code from the workspace; refused until the workspace is trusted. */
const EXEC_PATHS = new Set(['/api/tests/run', '/api/snapshots/run', '/api/deps/install']);

const GITHUB_STATUS: Record<GitHubError['kind'], 401 | 403 | 404 | 422 | 429 | 502> = {
  auth: 401,
  forbidden: 403,
  notFound: 404,
  validation: 422,
  rateLimit: 429,
  network: 502,
};

interface RawReview {
  user: { login: string } | null;
  state: string;
  submitted_at?: string;
}

export interface ReviewerState {
  login: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  submittedAt?: string;
}

/** Latest review state per reviewer; a later COMMENTED keeps an earlier APPROVED / CHANGES_REQUESTED (as on GitHub). */
export function latestReviews(list: RawReview[]): ReviewerState[] {
  const out = new Map<string, ReviewerState>();
  for (const r of list) {
    const login = r.user?.login;
    if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(r.state)) continue;
    const prev = out.get(login);
    if (r.state === 'DISMISSED') {
      out.set(login, { login, state: 'COMMENTED', submittedAt: r.submitted_at });
      continue;
    }
    if (r.state === 'COMMENTED' && prev && prev.state !== 'COMMENTED') continue;
    out.set(login, { login, state: r.state as ReviewerState['state'], submittedAt: r.submitted_at });
  }
  return [...out.values()];
}

/** Rewrites the request URL path, keeping the query, method, headers and body. */
function rewrite(req: Request, pathname: string): Request {
  const url = new URL(req.url);
  url.pathname = pathname;
  return new Request(url, req);
}

/**
 * Top-level app: guard → GitHub / workspace APIs → `/api/w/:ws/*` and `/w/:ws/raw/*` (rewritten to the
 * workspace's own `createApp`) → the local workspace's `createApp` → the viewer.
 */
export function createServerApp(opts: ServerAppOptions): Hono {
  const { manager, tokens } = opts;
  const app = new Hono();
  const apps = new Map<string, { gen: number; app: Hono }>();
  const local = opts.local ? createApp(opts.local) : null;
  const diffs = new DiffService(manager.git);
  const threads = new ThreadService(manager.github);

  app.use('*', guard({ port: opts.port, devOrigins: opts.devOrigins }));

  app.onError((err, c) => {
    if (err instanceof OpenRequestError) return c.json({ error: err.message, code: err.code, message: err.message }, 400);
    if (err instanceof WorkspaceError) return c.json({ error: err.message, code: err.code }, err.status);
    if (err instanceof GitHubError) return c.json({ error: err.message, code: `github-${err.kind}` }, GITHUB_STATUS[err.kind]);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  const appFor = (id: string) => {
    const { ws, ctx } = manager.context(id);
    let entry = apps.get(id);
    if (!entry || entry.gen !== ws.generation) {
      entry = { gen: ws.generation, app: createApp(ctx) };
      apps.set(id, entry);
    }
    return { ws, app: entry.app };
  };

  // --- GitHub ---
  app.get('/api/github/auth', async (c) => c.json(await tokens.status()));

  app.get('/api/github/pulls', async (c) => {
    const { owner, repo } = parseRepo(c.req.query('repo'));
    const list = await manager.github.rest<Parameters<typeof toPullInfo>[0][]>('GET', `/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=desc&per_page=30`);
    return c.json(list.map((p) => {
      const { number, title, author, headRef, baseRef } = toPullInfo(p);
      return { number, title, author, headRef, baseRef };
    }));
  });

  // --- workspaces ---
  app.get('/api/workspaces', (c) => c.json({ local: Boolean(local), workspaces: manager.list() }));

  app.post('/api/workspaces', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ws = manager.open({ repo: body.repo, pr: body.pr, ref: body.ref });
    return c.json({ id: ws.id, state: ws.state }, 202);
  });

  app.get('/api/workspaces/:id', (c) => {
    const ws = manager.get(c.req.param('id'));
    return ws ? c.json(manager.info(ws)) : c.json({ error: 'not found', code: 'not-found' }, 404);
  });

  app.get('/api/workspaces/:id/events', (c) => {
    const ws = manager.get(c.req.param('id'));
    if (!ws) return c.json({ error: 'not found', code: 'not-found' }, 404);
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'state', data: JSON.stringify(manager.info(ws)) });
      await new Promise<void>((resolve) => {
        const onEvent = (e: WorkspaceEvent) => {
          const { type, ...data } = e;
          void stream.writeSSE({ event: type, data: JSON.stringify(data) });
        };
        const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 25000);
        ws.events.on('event', onEvent);
        stream.onAbort(() => {
          clearInterval(ping);
          ws.events.off('event', onEvent);
          resolve();
        });
      });
    });
  });

  app.post('/api/workspaces/:id/refresh', (c) => {
    const id = c.req.param('id');
    void manager.refresh(id).catch(() => undefined);
    return c.json(manager.info(manager.get(id)!), 202);
  });

  app.post('/api/workspaces/:id/trust', async (c) => c.json(await manager.trust(c.req.param('id'))));

  app.post('/api/workspaces/:id/check', async (c) => {
    const id = c.req.param('id');
    const stale = await manager.checkHead(id);
    return c.json({ stale, ...manager.info(manager.get(id)!) });
  });

  app.delete('/api/workspaces/:id', async (c) => {
    await manager.close(c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- per-workspace API (GitHub-only endpoints first, then the rewritten existing API) ---
  app.get('/api/w/:ws/pr', async (c) => {
    const { ws } = appFor(c.req.param('ws'));
    const pr = await manager.pull(ws.id).catch(() => ws.pr);
    const reviews = ws.target.pr
      ? await manager.github
          .paginate<RawReview>(`/repos/${ws.target.owner}/${ws.target.repo}/pulls/${ws.target.pr}/reviews?per_page=100`)
          .then(latestReviews)
          .catch(() => [])
      : [];
    return c.json({ ...manager.info(ws), baseRef: ws.baseRef, mergeBase: ws.mergeBase, pr: pr ?? null, reviews });
  });

  app.get('/api/w/:ws/pr/files', async (c) => {
    const { ws, ctx } = manager.context(c.req.param('ws'));
    return c.json(await diffs.files(ws, ctx.config));
  });

  app.get('/api/w/:ws/pr/diff', async (c) => {
    const { ws, ctx } = manager.context(c.req.param('ws'));
    return c.json(await diffs.docDiff(ws, ctx.config, normalizePath(c.req.query('path') ?? '')));
  });

  app.get('/api/w/:ws/pr/threads', async (c) => {
    const { ws } = manager.context(c.req.param('ws'));
    const p = c.req.query('path');
    return c.json(await threads.list(ws, p ? normalizePath(p) : undefined));
  });

  app.all('/api/w/:ws/*', async (c) => {
    const id = c.req.param('ws');
    const { ws, app: wsApp } = appFor(id);
    const rest = c.req.path.slice(`/api/w/${encodeURIComponent(id)}`.length) || '/';
    const target = `/api${rest}`;
    if (c.req.method === 'POST' && EXEC_PATHS.has(target) && !ws.trusted) {
      return c.json({ error: 'このワークスペースのコードの実行は許可されていません', code: 'untrusted' }, 403);
    }
    return wsApp.fetch(rewrite(c.req.raw, target));
  });

  app.get('/w/:ws/raw/*', async (c) => {
    const id = c.req.param('ws');
    const { app: wsApp } = appFor(id);
    const rest = c.req.path.slice(`/w/${encodeURIComponent(id)}/raw`.length);
    return wsApp.fetch(rewrite(c.req.raw, `/raw${rest}`));
  });

  // --- local workspace ---
  if (local) {
    app.all('/api/*', (c) => local.fetch(c.req.raw));
    app.get('/raw/*', (c) => local.fetch(c.req.raw));
  } else {
    app.all('/api/*', (c) => c.json({ error: '手元のワークスペースはありません（--repo を指定して起動してください）', code: 'no-local' }, 404));
    app.get('/raw/*', (c) => c.json({ error: 'no local workspace', code: 'no-local' }, 404));
  }

  const dist = opts.dist;
  if (dist && existsSync(dist)) {
    app.get('*', async (c) => {
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '');
      let abs = path.resolve(dist, rel);
      if (!abs.startsWith(dist) || !(await fs.stat(abs).catch(() => null))?.isFile()) abs = path.join(dist, 'index.html');
      return new Response(await fs.readFile(abs), { headers: { 'content-type': mimeOf(abs) } });
    });
  }

  return app;
}
