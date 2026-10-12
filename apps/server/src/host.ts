import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { GitHubError, type TokenResolver } from '@ddv/github';
import { createApp, createContext, mimeOf, type ServerContext } from './app.ts';
import { normalizePath } from '@ddv/core';
import { listDirs } from './folders.ts';
import { guard, type SessionAuth } from './guard.ts';
import { LocalError, LocalWorkspace, type LocalEvent } from './local.ts';
import { DiffService } from './pr-diff.ts';
import { RecentFolders } from './recent.ts';
import { PendingStore, ReviewService } from './review.ts';
import { ReviewError } from './review-error.ts';
import { StatusCommitter } from './status-commit.ts';
import { ThreadService } from './threads.ts';
import { OpenRequestError, parseRepo, toPullInfo, WorkspaceError, type WorkspaceEvent, type WorkspaceManager } from './workspaces.ts';
import type { RunRecord } from './runs.ts';

export interface ServerAppOptions {
  /** The local workspace (one folder, chosen at start-up or in the viewer). Absent = an empty one with `<home>/recent.json`. */
  local?: LocalWorkspace;
  manager: WorkspaceManager;
  tokens: TokenResolver;
  /** Port the server listens on (Host check). */
  port: number;
  devOrigins?: string[];
  /** Built viewer (apps/web/dist) served for any other GET. */
  dist?: string;
  /** Start token / session cookie check (`ddv serve`); absent = Host / Origin only. */
  auth?: SessionAuth;
}

/** `<meta name="ddv-auth" content="required">` right after `<head>`: the viewer shows TokenRequired without calling the API. */
export function markTokenRequired(html: string): string {
  const meta = '<meta name="ddv-auth" content="required">';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`) : `${meta}${html}`;
}

/** POSTs that run code from the workspace; refused until the workspace is trusted. */
const EXEC_PATHS = new Set(['/api/tests/run', '/api/tests/rerun', '/api/snapshots/run', '/api/deps/install']);

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
  const local = opts.local ?? new LocalWorkspace({ recent: new RecentFolders(path.join(manager.home, 'recent.json')), createContext: (d) => createContext(d) });
  const dist = opts.dist && existsSync(opts.dist) ? opts.dist : undefined;
  const diffs = new DiffService(manager.git);
  const threads = new ThreadService(manager.github);
  const review = new ReviewService({
    store: new PendingStore(manager.home),
    github: manager.github,
    git: manager.git,
    committer: new StatusCommitter(manager.github),
    refresh: (id) => manager.refresh(id),
    pull: (id) => manager.pull(id),
    onChange: (id) => threads.invalidate(id),
  });

  const tokenPage = async () => (dist ? markTokenRequired(await fs.readFile(path.join(dist, 'index.html'), 'utf8').catch(() => '')) || null : null);
  app.use('*', guard({ port: opts.port, devOrigins: opts.devOrigins, auth: opts.auth, tokenPage }));

  app.onError((err, c) => {
    if (err instanceof LocalError) return c.json(err.toJSON(), err.status);
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
      ctx.testData = () => {
        const cur = manager.context(id).ws;
        return cur.target.pr ? { kind: 'pr', target: cur, review } : { kind: 'branch' };
      };
      entry = { gen: ws.generation, app: createApp(ctx) };
      apps.set(id, entry);
    }
    return { ws, app: entry.app };
  };

  // --- local workspace (LOCALF) ---
  const pathBody = async (c: Context): Promise<string> => {
    const b = (await c.req.json().catch(() => null)) as { path?: unknown } | null;
    if (!b || typeof b !== 'object' || typeof b.path !== 'string') throw new LocalError(400, 'bad-request', 'path（文字列）を指定してください');
    return b.path;
  };

  app.get('/api/local', async (c) => c.json(await local.info()));

  app.post('/api/local/open', async (c) => c.json(await local.open(await pathBody(c))));

  app.post('/api/local/close', async (c) => {
    await local.close();
    return c.json({ ok: true });
  });

  app.delete('/api/local/recent', async (c) => c.json({ recent: await local.removeRecent(await pathBody(c)) }));

  app.get('/api/fs/dirs', async (c) => c.json(await listDirs(c.req.query('path'), local.env)));

  // Change / run notifications of whichever folder is open; `local` when the folder is swapped or closed.
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'hello', data: '{}' });
      await new Promise<void>((resolve) => {
        let detach = () => {};
        const attach = () => {
          detach();
          detach = () => {};
          const ctx = local.ctx;
          if (!ctx) return;
          const onChange = (paths: string[]) => void stream.writeSSE({ event: 'change', data: JSON.stringify(paths) });
          const onEnd = (id: string, run?: { kind?: string }) => void stream.writeSSE({ event: 'run-end', data: JSON.stringify({ id, kind: run?.kind ?? 'test' }) });
          const onRun = (id: string, run: RunRecord) =>
            void stream.writeSSE({ event: 'run', data: JSON.stringify({ id, kind: 'test', rerunOf: run.rerunOf, attempt: run.attempt, times: run.times }) });
          ctx.events.on('change', onChange);
          ctx.runs.on('end', onEnd);
          ctx.runs.on('run', onRun);
          detach = () => {
            ctx.events.off('change', onChange);
            ctx.runs.off('end', onEnd);
            ctx.runs.off('run', onRun);
          };
        };
        const onLocal = (ev: LocalEvent) => {
          attach();
          void stream.writeSSE({ event: 'local', data: JSON.stringify(ev) });
        };
        attach();
        local.events.on('local', onLocal);
        const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 25000);
        stream.onAbort(() => {
          clearInterval(ping);
          detach();
          local.events.off('local', onLocal);
          resolve();
        });
      });
    }),
  );

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
  app.get('/api/workspaces', (c) => c.json({ local: local.ctx !== null, workspaces: manager.list() }));

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
    const ws = manager.get(id)!;
    void manager
      .refresh(id)
      .then(() => (ws.state === 'Ready' && ws.target.pr ? review.relocate(ws).then(() => undefined) : undefined))
      .catch(() => undefined);
    return c.json(manager.info(ws), 202);
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
  const loadReviews = (ws: { target: { owner: string; repo: string; pr?: number } }) =>
    ws.target.pr
      ? manager.github
          .paginate<RawReview>(`/repos/${ws.target.owner}/${ws.target.repo}/pulls/${ws.target.pr}/reviews?per_page=100`)
          .then(latestReviews)
          .catch(() => [] as ReviewerState[])
      : Promise.resolve([] as ReviewerState[]);

  app.get('/api/w/:ws/pr', async (c) => {
    const { ws } = appFor(c.req.param('ws'));
    const pr = await manager.pull(ws.id).catch(() => ws.pr);
    const reviews = await loadReviews(ws);
    return c.json({ ...manager.info(ws), baseRef: ws.baseRef, mergeBase: ws.mergeBase, pr: pr ?? null, reviews });
  });

  app.get('/api/w/:ws/reviews', async (c) => {
    const { ws } = manager.context(c.req.param('ws'));
    return c.json(await loadReviews(ws));
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

  /*
   * Review writes (REVCMT). Errors: { error, code, message } with 400 / 404 / 409 / 422 (ReviewError) or GitHub's status (github-<kind>).
   *
   * Anchor   = { path, side: 'RIGHT'|'LEFT', startLine, line, lineText: string[], element: { kind, key, label } }
   * Anchor input (any of): a full Anchor (lineText is re-read from the file) | { path, side?, startLine?, line?, element? } (lines win over
   * element) | { path, element: { kind, key, label? }, side? } (lines computed from the element; RIGHT only, no mockElement).
   * Comment input = { anchor?: <anchor input>  |  path, element, side (top-level), body, suggestion? }   suggestion: ''/null = none, RIGHT only
   * PendingComment = { id, anchor, body, suggestion?, state: 'Pending'|'Drifted', placement: 'line'|'file', shrunk?, commitId, reason? }
   *
   * GET    /api/w/<ws>/review                      → 200 { headSha, mergeBase?, comments: PendingComment[] }
   * POST   /api/w/<ws>/review/comments             → 201 PendingComment            (body empty 422 comment-required, >2000 comment-too-long)
   * PATCH  /api/w/<ws>/review/comments/<id>        → 200 PendingComment            ({ body?, suggestion?, anchor? | path+element }; a new anchor → Pending)
   * DELETE /api/w/<ws>/review/comments/<id>        → 200 { ok: true }
   * POST   /api/w/<ws>/review/submit               → 200 SubmitResult              { event: COMMENT|APPROVE|REQUEST_CHANGES, body?, approveDocs?: string[] }
   *   SubmitResult = { reviewId, reviewUrl, posted: { line, file, body }, failed: [{ id, message }], statusCommit?: { mode: 'commit', sha, paths } | { mode: 'suggestion', paths }, warnings?: string[] }
   *   422 drifted / body-required / body-too-long / invalid-event, 409 stale (head moved), GitHub's 422 on review creation (nothing is removed)
   * GET    /api/w/<ws>/reviews                     → 200 ReviewerState[] [{ login, state, submittedAt? }]
   * POST   /api/w/<ws>/pr/threads/<id>/replies     { body } → 201 ThreadComment
   * POST   /api/w/<ws>/pr/threads/<id>/resolve     { resolved: boolean } → 200 { id, resolved }
   */
  const guarded = async (c: Context, fn: () => Promise<Response>): Promise<Response> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ReviewError) return c.json({ error: e.message, code: e.code, message: e.message }, e.status);
      if (e instanceof GitHubError) return c.json({ error: e.message, code: `github-${e.kind}`, message: e.message }, GITHUB_STATUS[e.kind]);
      throw e;
    }
  };
  const jsonBody = async (c: Context): Promise<Record<string, unknown>> => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ReviewError(400, 'bad-request', 'JSON オブジェクトで指定してください');
    return b as Record<string, unknown>;
  };

  app.get('/api/w/:ws/review', (c) => guarded(c, async () => c.json(await review.get(manager.context(c.req.param('ws')).ws))));

  app.post('/api/w/:ws/review/comments', (c) =>
    guarded(c, async () => {
      const { ws } = manager.context(c.req.param('ws'));
      return c.json(await review.add(ws, await jsonBody(c)), 201);
    }),
  );

  app.patch('/api/w/:ws/review/comments/:id', (c) =>
    guarded(c, async () => {
      const { ws } = manager.context(c.req.param('ws'));
      return c.json(await review.update(ws, c.req.param('id'), await jsonBody(c)));
    }),
  );

  app.delete('/api/w/:ws/review/comments/:id', (c) =>
    guarded(c, async () => {
      const { ws } = manager.context(c.req.param('ws'));
      await review.remove(ws, c.req.param('id'));
      return c.json({ ok: true });
    }),
  );

  app.post('/api/w/:ws/review/submit', (c) =>
    guarded(c, async () => {
      const { ws } = manager.context(c.req.param('ws'));
      const b = await jsonBody(c);
      return c.json(await review.submit(ws, b.event, b.body, b.approveDocs));
    }),
  );

  app.post('/api/w/:ws/pr/threads/:id/replies', (c) =>
    guarded(c, async () => {
      const { ws } = manager.context(c.req.param('ws'));
      return c.json(await threads.reply(ws, c.req.param('id'), (await jsonBody(c)).body), 201);
    }),
  );

  app.post('/api/w/:ws/pr/threads/:id/resolve', (c) =>
    guarded(c, async () => {
      const { ws } = manager.context(c.req.param('ws'));
      const b = await jsonBody(c);
      if (typeof b.resolved !== 'boolean') throw new ReviewError(422, 'bad-request', 'resolved（真偽値）が必要です');
      return c.json(await threads.resolve(ws, c.req.param('id'), b.resolved));
    }),
  );

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
  app.all('/api/*', (c) => local.fetch(c.req.raw));
  app.get('/raw/*', (c) => local.fetch(c.req.raw));

  if (dist) {
    app.get('*', async (c) => {
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '');
      let abs = path.resolve(dist, rel);
      if (!abs.startsWith(dist) || !(await fs.stat(abs).catch(() => null))?.isFile()) abs = path.join(dist, 'index.html');
      if (abs !== path.join(dist, 'index.html')) return new Response(await fs.readFile(abs), { headers: { 'content-type': mimeOf(abs) } });
      const html = await fs.readFile(abs, 'utf8');
      const session = opts.auth ? opts.auth.valid(c.req.header('cookie')) : true;
      return new Response(session ? html : markTokenRequired(html), { headers: { 'content-type': mimeOf(abs), 'cache-control': 'no-store' } });
    });
  }

  return app;
}
