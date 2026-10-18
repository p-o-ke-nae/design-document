import { watch, promises as fs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { normalizePath, type DdvConfig } from '@ddv/core';
import { loadConfig, toPosix, CONFIG_FILES } from '@ddv/core/node';
import { generateAll, LOCK_PATH } from '@ddv/testid';
import { checkMocks, scaffoldMock } from '@ddv/mock';
import { checkTokens } from '@ddv/tokens/node';
import {
  createServices,
  HistoryError,
  NO_TRACE_MESSAGE,
  ServiceError,
  systemEnv,
  TestDataError,
  TestDataService,
  TraceError,
  type HistoryService,
  type Reviewer,
  type Services,
  type TestDataDraft,
  type TestDataWorkspace,
  type TraceService,
} from '@ddv/services';
import { RerunError, RunManager, runnersOf, RUNS_DIR, type ExecuteRunner, type RunEvent, type RunRecord } from './runs.ts';
import { listTargets, serverGate, validateRunRequest, type RunnerGate } from './targets.ts';
import { TRACES_DIR } from './prune.ts';
import { checkDeps, installDeps } from './deps.ts';
import { FsRepoReader, FsRepoWriter } from './fs-reader.ts';
import { FsPlayStore, recordPlay } from './scenarios.ts';
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
  /** The working folder (the file watcher invalidates it). */
  reader: FsRepoReader;
  writer: FsRepoWriter;
  /** @ddv/services over 
eader (the route handlers call these). */
  services: Services;
  history: HistoryService;
  traces: TraceService;
  snapshots: SnapshotService;
  /** Whether each target can run here (`DDV_DESKTOP_GATE` replaces it, e.g. in E2E). */
  gate: RunnerGate;
  events: EventEmitter;
  /** GitHub workspaces: refuse test runs (409 deps-missing) until the runners' packages are installed. */
  checkDeps?: boolean;
  /** GitHub workspaces: the kind (pr / branch) and review service for the test-data editor (DD-TDEDIT). Absent = the local workspace. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  testData?: () => TestDataWorkspace<any> & { review?: Reviewer<any> };
  /** The Actions feature (actions-api.ts `ActionsHost`): `actions` SSE subscribers. Set by the host. */
  actions?: { subscribe(listener: (e: object) => void): () => void };
  close(): void;
}

/** Creates the context: loads config, run history and starts watching the repository. */
export async function createContext(
  repoRoot: string,
  opts: { watch?: boolean; snapshots?: ConstructorParameters<typeof SnapshotService>[2]; gate?: RunnerGate; execute?: ExecuteRunner } = {},
): Promise<ServerContext> {
  const root = path.resolve(repoRoot);
  const ctx: ServerContext = {
    repoRoot: root,
    config: await loadConfig(root),
    runs: undefined as unknown as RunManager,
    reader: new FsRepoReader(root),
    writer: undefined as unknown as FsRepoWriter,
    services: undefined as unknown as Services,
    history: undefined as unknown as HistoryService,
    traces: undefined as unknown as TraceService,
    snapshots: undefined as unknown as SnapshotService,
    gate: opts.gate ?? serverGate(root),
    events: new EventEmitter(),
    close: () => {},
  };
  ctx.events.setMaxListeners(100);
  ctx.runs = new RunManager(root, () => ctx.config, { execute: opts.execute });
  ctx.runs.setMaxListeners(100);
  ctx.writer = new FsRepoWriter(ctx.reader);
  const runs = ctx.runs;
  ctx.services = createServices({
    env: systemEnv,
    reader: ctx.reader,
    writer: ctx.writer,
    getConfig: () => ctx.config,
    runs: { list: () => runs.list(), failedIdsOfLatest: () => runs.failedIdsOfLatest(), onEnd: (l) => runs.onEnd(l), get: (id) => runs.get(id) },
    repoName: path.basename(root),
    repoRoot: root,
    plays: new FsPlayStore(root),
  });
  ctx.history = ctx.services.history;
  ctx.traces = ctx.services.traces;
  ctx.snapshots = new SnapshotService(root, () => ctx.config, opts.snapshots);
  await ctx.runs.load();
  await ctx.runs.prune();
  if (opts.watch !== false) {
    let watcher: FSWatcher | null = null;
    const pending = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    let closed = false;
    const startWatch = () => {
      watcher = watch(root, { recursive: true }, (_ev, file) => {
        if (!file) return;
        const rel = toPosix(file.toString());
        if (/(^|\/)(node_modules|\.git|bin|obj|dist|test-results|playwright-report)(\/|$)/.test(rel) || rel.startsWith(RUNS_DIR) || rel.startsWith(SNAPSHOTS_DIR) || rel.startsWith(TRACES_DIR)) return;
        pending.add(rel);
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          const paths = [...pending];
          pending.clear();
          ctx.reader.invalidate(paths);
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
      // On Linux, Node's recursive watch emits ENOENT when a watched folder is removed (e.g. test-results):
      // unhandled, it would end the server. Start watching again instead.
      watcher.on('error', (e) => {
        watcher?.close();
        watcher = null;
        if (closed) return;
        console.warn('[ddv] ファイル監視を再開します:', e.message);
        setTimeout(() => {
          if (closed) return;
          try {
            startWatch();
          } catch (err) {
            console.warn('[ddv] ファイル監視を再開できません:', (err as Error).message);
          }
        }, 500).unref();
      });
    };
    try {
      startWatch();
    } catch (e) {
      console.warn('[ddv] ファイル監視を開始できません:', (e as Error).message);
    }
    ctx.close = () => {
      closed = true;
      watcher?.close();
    };
  }
  return ctx;
}

/** services.md「例外の写像」: `{ error, code, message, ...extra }`（code が無いものは `{ error }` だけ）。 */
export const serviceErrorBody = (e: ServiceError): Record<string, unknown> => (e.code ? { error: e.message, code: e.code, message: e.message, ...e.extra } : { error: e.message });

export function createApp(ctx: ServerContext): Hono {
  const app = new Hono();
  const root = ctx.repoRoot;
  const svc = () => ctx.services;

  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json(serviceErrorBody(err), err.status as 404);
    const status = /escapes repository|ENOENT|not found/i.test(err.message) ? 404 : 500;
    return c.json({ error: err.message }, status);
  });

  app.notFound((c) => c.json({ error: `API がありません: ${c.req.method} ${c.req.path}`, code: 'not-found' }, 404));

  app.get('/api/config', (c) => c.json(svc().docs.config()));

  app.get('/api/tree', async (c) => c.json(await svc().docs.tree()));

  app.get('/api/file', async (c) => c.text(await svc().docs.file(c.req.query('path') ?? '')));

  app.get('/api/doc', async (c) => c.json(await svc().docs.doc(normalizePath(c.req.query('path') ?? ''))));

  app.get('/api/resolve', async (c) => {
    const r = await svc().docs.resolve(c.req.query('from') ?? '', c.req.query('ref') ?? '');
    return r.ok ? c.json(r) : c.json(r, 404);
  });

  app.get('/raw/*', async (c) => {
    const rel = decodeURIComponent(c.req.path.slice('/raw/'.length));
    const st = await ctx.reader.stat(rel);
    if (!st) return c.text('not found', 404);
    return new Response(new Uint8Array(await ctx.reader.readBinary(st.path)), { headers: { 'content-type': mimeOf(st.path), 'cache-control': 'no-store' } });
  });

  app.get('/api/tests', async (c) => c.json(await svc().matrix.tests(ctx.history.latest())));
  app.get('/api/tests/targets', async (c) => c.json({ targets: await listTargets(ctx.config, ctx.gate) }));
  app.post('/api/tests/run', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; runner?: unknown; runners?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : undefined;
    const runner = typeof body.runner === 'string' ? body.runner : undefined;
    const runners = body.runners === undefined || body.runners === null ? undefined : Array.isArray(body.runners) ? body.runners.map(String) : [];
    // platform-results.md「開始の要求」: before the deps checks.
    const invalid = await validateRunRequest({ ...(body.runner !== undefined ? { runner: String(body.runner) } : {}), ...(runners ? { runners } : {}) }, () => listTargets(ctx.config, ctx.gate));
    if (invalid) return c.json({ error: invalid.error, code: invalid.code }, invalid.status);
    if (runner && !ctx.config.runners.some((r) => r.name === runner)) return c.json({ error: `unknown runner: ${runner}` }, 400);
    if (ctx.runs.activeTask('deps')) return c.json({ error: '依存の導入が進行中です。終わってから実行してください', code: 'deps-installing' }, 409);
    if (ctx.checkDeps) {
      const all = checkDeps(root, ctx.config);
      const targets = all.targets.filter((t) => (!runner && !runners) || t.runners.some((n) => (runner ? n === runner : runnersOf(ctx.config, { runners }).some((r) => r.name === n))));
      if (targets.length) return c.json({ error: 'テストの実行に必要な依存が導入されていません', code: 'deps-missing', deps: { ...all, needed: true, targets } }, 409);
    }
    try {
      const run = ctx.runs.start({ ids, runner, ...(runners ? { runners } : {}) });
      return c.json({ id: run.id, status: run.status }, 202);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  app.post('/api/tests/rerun', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { times?: unknown };
    const times = body.times;
    if (typeof times !== 'number' || !Number.isInteger(times) || times < 1 || times > 5) {
      const e = new RerunError('times-invalid');
      return c.json({ error: e.message, code: e.code }, 400);
    }
    if (ctx.runs.activeTask('deps')) return c.json({ error: '依存の導入が進行中です。終わってから実行してください', code: 'deps-installing' }, 409);
    if (ctx.checkDeps) {
      const all = checkDeps(root, ctx.config);
      if (all.targets.length) return c.json({ error: 'テストの実行に必要な依存が導入されていません', code: 'deps-missing', deps: { ...all, needed: true } }, 409);
    }
    try {
      const run = ctx.runs.rerun(times);
      return c.json({ id: run.id, status: run.status, rerunOf: run.rerunOf, attempt: run.attempt, times: run.times }, 202);
    } catch (e) {
      if (e instanceof RerunError) return c.json({ error: e.message, code: e.code }, e.code === 'times-invalid' ? 400 : 409);
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  app.get('/api/history/summary', async (c) => c.json(await ctx.history.summary()));

  app.get('/api/history/flaky', async (c) => c.json(await ctx.history.flaky()));

  app.get('/api/history/tests/:id', async (c) => {
    try {
      return c.json(await ctx.history.test(c.req.param('id'), c.req.query('platform')));
    } catch (e) {
      if (e instanceof HistoryError) return c.json({ error: e.message, code: e.code }, e.status);
      throw e;
    }
  });

  app.get('/api/coverage', async (c) => {
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path is required' }, 400);
    try {
      return c.json(await ctx.history.coverage(p));
    } catch {
      return c.json({ error: `文書が見つかりません: ${p}`, code: 'not-found' }, 404);
    }
  });

  app.get('/api/runs', (c) => c.json(ctx.runs.list().map(({ log: _log, traces: _traces, ...r }) => ({ ...r, total: Object.keys(r.results).length }))));

  app.get('/api/deps', (c) => c.json(checkDeps(root, ctx.config)));

  app.post('/api/deps/install', (c) => {
    if (ctx.runs.active) return c.json({ error: 'テストの実行中は依存を導入できません' }, 409);
    const status = checkDeps(root, ctx.config);
    try {
      const run = ctx.runs.startTask('deps', {}, async (h) => {
        if (!status.targets.length) {
          h.log('導入が必要な依存はありません');
          return 'passed';
        }
        if (!(await installDeps(root, status.targets, h.log))) return 'error';
        const after = checkDeps(root, ctx.config);
        for (const t of after.targets) h.log(`! 導入後も ${t.missing.join(', ')} が見つかりません（${t.dir}）`);
        return after.needed ? 'error' : 'passed';
      });
      return c.json({ runId: run.id, deps: status }, 202);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  app.get('/api/runs/:id', async (c) => {
    const r = ctx.runs.runs.get(c.req.param('id'));
    if (!r) return c.json({ error: 'not found' }, 404);
    const traceOf: Record<string, boolean> = {};
    for (const id of r.traces ?? []) traceOf[id] = await ctx.traces.exists(r.id, id);
    return c.json({ ...r, traceOf });
  });

  app.get('/api/traces/:runId/:testId/steps/:file', async (c) => {
    const m = /^(\d+)\.png$/.exec(c.req.param('file'));
    try {
      const png = m ? await ctx.traces.screenshot(c.req.param('runId'), c.req.param('testId'), Number(m[1]), c.req.query('platform')) : null;
      if (!png) return c.json({ error: 'スクリーンショットはありません' }, 404);
      return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' } });
    } catch (e) {
      if (e instanceof TraceError) return c.json({ code: e.code, error: e.message }, e.status as 400);
      throw e;
    }
  });

  app.get('/api/traces/:runId/:testId/evidence/:file', async (c) => {
    try {
      const file = c.req.param('file');
      const r = await ctx.traces.evidence(c.req.param('runId'), c.req.param('testId'), c.req.query('platform'), file);
      const headers: Record<string, string> = {
        'content-type': r.contentType,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=86400',
      };
      if (c.req.query('download') === '1') headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeRfc5987(file)}`;
      return new Response(new Uint8Array(r.bytes), { headers });
    } catch (e) {
      if (e instanceof TraceError) return c.json({ code: e.code, error: e.message }, e.status as 400);
      throw e;
    }
  });
  app.get('/api/traces/:runId/:testId', async (c) => {
    try {
      const r = await ctx.traces.read(c.req.param('runId'), c.req.param('testId'), c.req.query('platform'));
      return r.ok ? c.json(r.trace) : c.json({ code: r.reason, error: NO_TRACE_MESSAGE[r.reason] }, 404);
    } catch (e) {
      if (e instanceof TraceError) return c.json({ code: e.code, error: e.message }, e.status as 400);
      throw e;
    }
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

  app.get('/api/results/latest', async (c) => {
    const out: Record<string, ReturnType<HistoryService['latest']>[string] & { trace: boolean }> = {};
    for (const [id, res] of Object.entries(ctx.history.latest())) {
      // Actions results: listed in `traces` is enough (actions-run.md「既存の API への追加」).
      const r = res.source === 'actions' ? ctx.history.record(res.runId) : ctx.runs.runs.get(res.runId);
      const listed = !!r?.traces?.includes(id);
      out[id] = { ...res, trace: listed && (res.source === 'actions' || (await ctx.traces.exists(res.runId, id))) };
    }
    return c.json(out);
  });
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'hello', data: '{}' });
      await new Promise<void>((resolve) => {
        const onChange = (paths: string[]) => void stream.writeSSE({ event: 'change', data: JSON.stringify(paths) });
        const onEnd = (id: string, run?: { kind?: string }) => void stream.writeSSE({ event: 'run-end', data: JSON.stringify({ id, kind: run?.kind ?? 'test' }) });
        const onRun = (id: string, run: RunRecord) =>
          void stream.writeSSE({ event: 'run', data: JSON.stringify({ id, kind: 'test', rerunOf: run.rerunOf, attempt: run.attempt, times: run.times }) });
        const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 25000);
        ctx.events.on('change', onChange);
        ctx.runs.on('end', onEnd);
        ctx.runs.on('run', onRun);
        const offActions = ctx.actions?.subscribe((e) => void stream.writeSSE({ event: 'actions', data: JSON.stringify(e) }));
        stream.onAbort(() => {
          clearInterval(ping);
          offActions?.();
          ctx.events.off('change', onChange);
          ctx.runs.off('end', onEnd);
          ctx.runs.off('run', onRun);
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
    const docs = await svc().docs.loadDocs();
    return c.json([...(await svc().docs.lint(docs)), ...(await checkMocks(root, ctx.config, docs)), ...(await checkTokens(root, ctx.config)), ...(await (await import('@ddv/evidence/check')).checkEvidence(root, ctx.config, docs)), ...(await (await import('@ddv/desktop/check')).checkDesktopNames(root, ctx.config, docs))]);
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

  app.get('/api/mocks', async (c) => c.json(await svc().mocks.mocks()));

  // Tune mode (DD-TUNE): source lines of a picked mock element, and the suggestion for a patch.
  app.post('/api/mock-source', async (c) => {
    const body = await c.req.json().catch(() => null);
    try {
      return c.json(await svc().mocks.source(body));
    } catch (e) {
      if (e instanceof ServiceError) return c.json(e.code ? { code: e.code, error: e.message, ...e.extra } : { error: e.message }, e.status as 400);
      throw e;
    }
  });

  app.get('/api/mocks/scenarios', async (c) => c.json({ scenarios: await svc().mocks.scenarios() }));

  app.get('/api/mocks/scenario', async (c) => {
    const id = c.req.query('id') ?? '';
    const d = id ? await svc().mocks.scenario(id) : null;
    return d ? c.json(d) : c.json({ error: `シナリオが見つかりません: ${id}` }, 404);
  });
  app.post('/api/mocks/played', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; ok?: unknown; failures?: unknown };
    if (typeof body.id !== 'string' || !body.id || typeof body.ok !== 'boolean') return c.json({ error: 'id（文字列）と ok（真偽値）が必要です' }, 400);
    const rec = await recordPlay(root, body.id, body.ok, Array.isArray(body.failures) ? body.failures : undefined);
    return c.json({ id: body.id, ...rec });
  });

  // Test-data editor (DD-TDEDIT). A GitHub workspace without a PR is read-only (branch).
  const testData = () => {
    const w = ctx.testData?.() ?? { kind: ctx.checkDeps ? ('branch' as const) : ('local' as const) };
    const s = w.review ? new TestDataService({ reader: ctx.reader, writer: ctx.writer, getConfig: () => ctx.config, env: systemEnv, mocks: svc().mocks }, w.review) : svc().testData;
    return { ws: w, svc: s };
  };  const tdError = (c: Context, e: unknown) => {
    if (e instanceof TestDataError) return c.json({ error: e.message, code: e.code, ...e.extra }, e.status as 403);
    throw e;
  };
  const draftOf = async (c: Context) => (await c.req.json().catch(() => null)) as TestDataDraft;

  app.get('/api/testdata', async (c) => {
    const { ws, svc } = testData();
    try {
      return c.json(await svc.load(c.req.query('scenario') ?? '', ws));
    } catch (e) {
      return tdError(c, e);
    }
  });

  app.post('/api/testdata/validate', async (c) => {
    const { ws, svc } = testData();
    try {
      return c.json(await svc.validate(await draftOf(c), ws));
    } catch (e) {
      return tdError(c, e);
    }
  });

  app.post('/api/testdata/save', async (c) => {
    const { ws, svc } = testData();
    try {
      return c.json(await svc.save(await draftOf(c), ws));
    } catch (e) {
      return tdError(c, e);
    }
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

/** RFC 5987 `ext-value` of a file name. */
export const encodeRfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
