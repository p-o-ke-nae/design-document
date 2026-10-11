import { watch, existsSync, promises as fs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { buildToc, extractSection, findHeading, normalizePath, resolveRefPath, splitRef, type DdvConfig } from '@ddv/core';
import { lintDocs, loadConfig, loadDoc, loadDocs, safeJoin, toPosix, traceIndex, walk, CONFIG_FILES } from '@ddv/core/node';
import { diffGraphs, parseMermaidGraph } from '@ddv/graph';
import { activeIds, docMatrices, generateAll, readLock, scanTestLinks, LOCK_PATH, type TestLink } from '@ddv/testid';
import { checkMocks, scaffoldMock } from '@ddv/mock';
import { RunManager, RUNS_DIR, type RunEvent } from './runs.ts';
import { listScenarios, recordPlay, scenarioDetail } from './scenarios.ts';
import { checkId, SnapshotError, SnapshotService, SNAPSHOTS_DIR, type SnapKind } from './snapshots.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeOf(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

export interface ServerContext {
  repoRoot: string;
  config: DdvConfig;
  runs: RunManager;
  snapshots: SnapshotService;
  events: EventEmitter;
  close(): void;
}

/** Creates the context: loads config, run history and starts watching the repository. */
export async function createContext(repoRoot: string, opts: { watch?: boolean; snapshots?: ConstructorParameters<typeof SnapshotService>[2] } = {}): Promise<ServerContext> {
  const root = path.resolve(repoRoot);
  const ctx: ServerContext = {
    repoRoot: root,
    config: await loadConfig(root),
    runs: undefined as unknown as RunManager,
    snapshots: undefined as unknown as SnapshotService,
    events: new EventEmitter(),
    close: () => {},
  };
  ctx.events.setMaxListeners(100);
  ctx.runs = new RunManager(root, () => ctx.config);
  ctx.runs.setMaxListeners(100);
  ctx.snapshots = new SnapshotService(root, () => ctx.config, opts.snapshots);
  await ctx.runs.load();
  if (opts.watch !== false) {
    let watcher: FSWatcher | null = null;
    const pending = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    try {
      watcher = watch(root, { recursive: true }, (_ev, file) => {
        if (!file) return;
        const rel = toPosix(file.toString());
        if (/(^|\/)(node_modules|\.git|bin|obj|dist|test-results|playwright-report)(\/|$)/.test(rel) || rel.startsWith(RUNS_DIR) || rel.startsWith(SNAPSHOTS_DIR)) return;
        pending.add(rel);
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          const paths = [...pending];
          pending.clear();
          if (paths.some((p) => CONFIG_FILES.includes(p))) {
            try {
              ctx.config = await loadConfig(root);
            } catch (e) {
              console.error('[ddv] 設定の再読込に失敗:', (e as Error).message);
            }
          }
          ctx.events.emit('change', paths);
        }, 150);
      });
    } catch (e) {
      console.warn('[ddv] ファイル監視を開始できません:', (e as Error).message);
    }
    ctx.close = () => watcher?.close();
  }
  return ctx;
}

function linkIndex(links: TestLink[]): Record<string, TestLink[]> {
  const out: Record<string, TestLink[]> = {};
  for (const l of links) (out[l.id] ??= []).push(l);
  return out;
}

export function createApp(ctx: ServerContext): Hono {
  const app = new Hono();
  const root = ctx.repoRoot;

  app.onError((err, c) => {
    const status = /escapes repository|ENOENT|not found/i.test(err.message) ? 404 : 500;
    return c.json({ error: err.message }, status);
  });

  app.notFound((c) => c.json({ error: `API がありません: ${c.req.method} ${c.req.path}`, code: 'not-found' }, 404));

  app.get('/api/config', (c) => c.json({ repoRoot: root, repoName: path.basename(root), config: ctx.config }));

  app.get('/api/tree', async (c) => {
    const docs = await loadDocs(root, ctx.config);
    return c.json({
      docsRoot: ctx.config.docsRoot,
      docs: docs.map((d) => ({ path: d.path, kind: d.kind, title: d.title, id: d.id, status: d.status, traces: d.parsed.frontMatter.traces ?? [] })),
    });
  });

  app.get('/api/file', async (c) => {
    const p = c.req.query('path') ?? '';
    return c.text(await fs.readFile(safeJoin(root, p), 'utf8'));
  });

  app.get('/api/doc', async (c) => {
    const p = normalizePath(c.req.query('path') ?? '');
    const doc = await loadDoc(root, p);
    const lock = structuredClone(await readLock(root));
    const matrices = docMatrices(doc, ctx.config, lock);
    const links = linkIndex(await scanTestLinks(root, ctx.config));
    const graphs: Record<string, unknown> = {};
    const diffs: Record<string, unknown> = {};
    for (const dg of doc.parsed.diagrams) {
      const g = parseMermaidGraph(dg.code);
      if (g) graphs[dg.id] = g;
    }
    for (const dg of doc.parsed.diagrams) {
      if (!dg.compare) continue;
      const before = graphs[dg.compare];
      const after = graphs[dg.id];
      if (before && after) diffs[dg.id] = { compare: dg.compare, ...diffGraphs(before as never, after as never) };
    }
    const allDocs = await loadDocs(root, ctx.config);
    const issues = lintDocs(root, ctx.config, allDocs).filter((i) => i.path === p);
    const index = traceIndex(allDocs, ctx.config);
    const traces = (Array.isArray(doc.parsed.frontMatter.traces) ? (doc.parsed.frontMatter.traces as unknown[]) : []).map(String).map((code) => {
      const to = index.get(code);
      return to ? { code, path: to } : { code };
    });
    return c.json({
      path: doc.path,
      kind: doc.kind,
      id: doc.id,
      title: doc.title,
      status: doc.status,
      frontMatter: doc.parsed.frontMatter,
      traces,
      text: doc.text,
      headings: doc.parsed.headings,
      toc: buildToc(doc.parsed.headings, ctx.config.toc.minLevel, ctx.config.toc.maxLevel),
      diagrams: doc.parsed.diagrams,
      directives: doc.parsed.directives,
      blocks: doc.parsed.blocks,
      graphs,
      diffs,
      matrices: matrices.map((m) => ({ ...m, cases: m.cases.map((cs) => ({ ...cs, links: links[cs.id] ?? [] })) })),
      issues,
    });
  });

  app.get('/api/resolve', async (c) => {
    const from = c.req.query('from') ?? '';
    const ref = c.req.query('ref') ?? '';
    const { path: rp, heading } = splitRef(ref);
    const target = resolveRefPath(from, rp);
    const abs = safeJoin(root, target);
    if (!existsSync(abs)) return c.json({ ok: false, path: target, heading, error: `ファイルが見つかりません: ${target}` }, 404);
    const text = await fs.readFile(abs, 'utf8');
    const section = extractSection(text, heading);
    if (!section) return c.json({ ok: false, path: target, heading, error: `見出しが見つかりません: #${heading}` }, 404);
    const doc = await loadDoc(root, target);
    const h = heading ? findHeading(doc.parsed, heading) : undefined;
    return c.json({ ok: true, path: target, heading, slug: h?.slug ?? '', title: doc.title, line: h?.line ?? 1, markdown: section.markdown });
  });

  app.get('/raw/*', async (c) => {
    const rel = decodeURIComponent(c.req.path.slice('/raw/'.length));
    const abs = safeJoin(root, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile()) return c.text('not found', 404);
    return new Response(await fs.readFile(abs), { headers: { 'content-type': mimeOf(abs), 'cache-control': 'no-store' } });
  });

  app.get('/api/tests', async (c) => {
    const lock = await readLock(root);
    const ids = activeIds(lock);
    const links = await scanTestLinks(root, ctx.config);
    const byId = linkIndex(links);
    const latest = ctx.runs.latest();
    const unitPrefix = `${ctx.config.idPrefix.detailed}-`;
    // Design level of the case: detailed-design ids are unit tests, requirement/basic-design ids are integration tests.
    const cases = [...ids].map(([id, v]) => ({ id, ...v, level: id.startsWith(unitPrefix) ? 'unit' : 'integration', links: byId[id] ?? [], latest: latest[id] ?? null }));
    const unknown = links.filter((l) => !ids.has(l.id));
    return c.json({ cases, unknown, runners: ctx.config.runners.map((r) => ({ name: r.name, type: r.type, level: r.level, cwd: r.cwd })) });
  });

  app.post('/api/tests/run', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; runner?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : undefined;
    const runner = typeof body.runner === 'string' ? body.runner : undefined;
    if (runner && !ctx.config.runners.some((r) => r.name === runner)) return c.json({ error: `unknown runner: ${runner}` }, 400);
    try {
      const run = ctx.runs.start({ ids, runner });
      return c.json({ id: run.id, status: run.status }, 202);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  app.get('/api/runs', (c) => c.json(ctx.runs.list().map(({ log: _log, ...r }) => ({ ...r, total: Object.keys(r.results).length }))));

  app.get('/api/runs/:id', (c) => {
    const r = ctx.runs.runs.get(c.req.param('id'));
    return r ? c.json(r) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/runs/:id/events', (c) => {
    const id = c.req.param('id');
    const run = ctx.runs.runs.get(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    return streamSSE(c, async (stream) => {
      for (const line of run.log) await stream.writeSSE({ event: 'log', data: line });
      for (const ev of run.events ?? []) await stream.writeSSE(ev);
      if (run.status !== 'running') {
        await stream.writeSSE({ event: 'end', data: JSON.stringify({ status: run.status }) });
        return;
      }
      await new Promise<void>((resolve) => {
        const onLog = (rid: string, line: string) => rid === id && void stream.writeSSE({ event: 'log', data: line });
        const onEvent = (rid: string, ev: RunEvent) => rid === id && void stream.writeSSE(ev);
        const onEnd = (rid: string) => {
          if (rid !== id) return;
          void stream.writeSSE({ event: 'end', data: JSON.stringify({ status: run.status }) }).then(cleanup);
        };
        const cleanup = () => {
          ctx.runs.off('log', onLog);
          ctx.runs.off('event', onEvent);
          ctx.runs.off('end', onEnd);
          resolve();
        };
        ctx.runs.on('log', onLog);
        ctx.runs.on('event', onEvent);
        ctx.runs.on('end', onEnd);
        stream.onAbort(cleanup);
      });
    });
  });

  app.get('/api/results/latest', (c) => c.json(ctx.runs.latest()));

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'hello', data: '{}' });
      await new Promise<void>((resolve) => {
        const onChange = (paths: string[]) => void stream.writeSSE({ event: 'change', data: JSON.stringify(paths) });
        const onEnd = (id: string, run?: { kind?: string }) => void stream.writeSSE({ event: 'run-end', data: JSON.stringify({ id, kind: run?.kind ?? 'test' }) });
        const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 25000);
        ctx.events.on('change', onChange);
        ctx.runs.on('end', onEnd);
        stream.onAbort(() => {
          clearInterval(ping);
          ctx.events.off('change', onChange);
          ctx.runs.off('end', onEnd);
          resolve();
        });
      });
    }),
  );

  app.post('/api/testids/generate', async (c) => {
    const r = await generateAll(root, ctx.config, { write: true });
    const provisional = r.matrices.flatMap((m) => m.cases.filter((x) => x.provisional).map((x) => x.id));
    return c.json({ changed: r.changed, lock: LOCK_PATH, added: provisional, retired: r.matrices.flatMap((m) => m.retired.map((x) => x.id)) });
  });

  app.get('/api/lint', async (c) => {
    const docs = await loadDocs(root, ctx.config);
    return c.json([...lintDocs(root, ctx.config, docs), ...(await checkMocks(root, ctx.config, docs))]);
  });

  app.post('/api/mocks/scaffold', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { mock?: unknown };
    const mock = typeof body.mock === 'string' && body.mock ? body.mock : undefined;
    try {
      return c.json(await scaffoldMock(root, ctx.config, mock));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.get('/api/mocks', async (c) => c.json(await walk(root, ctx.config.mocksRoot, (rel) => rel.endsWith('.html'))));

  app.get('/api/mocks/scenarios', async (c) => c.json({ scenarios: await listScenarios(root, ctx.config, ctx.runs) }));

  app.get('/api/mocks/scenario', async (c) => {
    const id = c.req.query('id') ?? '';
    const d = id ? await scenarioDetail(root, ctx.config, id) : null;
    return d ? c.json(d) : c.json({ error: `シナリオが見つかりません: ${id}` }, 404);
  });

  app.post('/api/mocks/played', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; ok?: unknown; failures?: unknown };
    if (typeof body.id !== 'string' || !body.id || typeof body.ok !== 'boolean') return c.json({ error: 'id（文字列）と ok（真偽値）が必要です' }, 400);
    const rec = await recordPlay(root, body.id, body.ok, Array.isArray(body.failures) ? body.failures : undefined);
    return c.json({ id: body.id, ...rec });
  });

  const snapError = (c: Context, e: unknown) => {
    if (e instanceof SnapshotError) return c.json({ error: e.message }, e.status);
    throw e;
  };

  app.post('/api/snapshots/run', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : undefined;
    try {
      ids?.forEach(checkId);
    } catch (e) {
      return snapError(c, e);
    }
    try {
      const run = ctx.snapshots.run(ctx.runs, ids?.length ? ids : undefined);
      return c.json({ runId: run.id }, 202);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  app.get('/api/snapshots', async (c) => {
    const id = c.req.query('id') ?? '';
    try {
      const list = await ctx.snapshots.list(id);
      return list ? c.json(list) : c.json({ error: `シナリオが見つかりません: ${id}` }, 404);
    } catch (e) {
      return snapError(c, e);
    }
  });

  app.get('/api/snapshots/image', async (c) => {
    const id = c.req.query('id') ?? '';
    const step = Number(c.req.query('step'));
    const kind = c.req.query('kind') as SnapKind;
    if (!['baseline', 'current', 'diff'].includes(kind) || !Number.isInteger(step) || step < 1) return c.json({ error: 'id / step / kind が不正です' }, 400);
    let file: string;
    try {
      file = ctx.snapshots.store.file(kind, id, step);
    } catch (e) {
      return snapError(c, e);
    }
    const buf = await fs.readFile(file).catch(() => null);
    if (!buf) return c.json({ error: 'not found' }, 404);
    return new Response(buf, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  });

  app.post('/api/snapshots/approve', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; steps?: unknown };
    if (typeof body.id !== 'string' || !body.id) return c.json({ error: 'id が必要です' }, 400);
    let steps: number[] | undefined;
    if (body.steps !== undefined && body.steps !== null) {
      if (!Array.isArray(body.steps) || !body.steps.every((n) => Number.isInteger(n))) return c.json({ error: 'steps はステップ番号（1 始まり）の配列です' }, 400);
      steps = body.steps as number[];
    }
    try {
      return c.json(await ctx.snapshots.approve(body.id, steps));
    } catch (e) {
      return snapError(c, e);
    }
  });

  return app;
}
