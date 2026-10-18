import { existsSync, promises as fs, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScenarioWith, StepError, stepResult, TraceRecorder, type Capture, type Driver, type EvidenceHost, type Scenario, type ScenarioSession, type Step } from '@ddv/mock';
import { traceKey, type TraceFile } from '@ddv/mock/trace-format';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidenceConfigOf } from './config.ts';
import type { EvidenceContext } from './index.ts';
import type { CaptureResult, Provider } from './providers/types.ts';
import { Redactor } from './redact.ts';
import { BAD_OUTPUT, EvidenceRunner, NO_OUTPUT, ProviderResolver, timeoutMessage, timeoutOf, unregisteredMessage } from './runner.ts';
import { normalizeSpec, type EvidenceSpecInput } from './spec.ts';
import { EvidenceStore } from './store.ts';

describe('時間の上限（TMO）', () => {
  const cfg = evidenceConfigOf({});
  it('[DD-EVRUN-TMO-P001][DD-EVRUN-TMO-T001][DD-EVRUN-TMO-T002] spec.timeout があればそれ', () => {
    expect(timeoutOf({ timeout: 1500 }, { timeout: 9000 }, cfg)).toBe(1500);
  });
  it('[DD-EVRUN-TMO-P002][DD-EVRUN-TMO-T003][DD-EVRUN-TMO-T004] 無ければ取得手段の timeout', () => {
    expect(timeoutOf({}, { timeout: 9000 }, cfg)).toBe(9000);
  });
  it('[DD-EVRUN-TMO-P003][DD-EVRUN-TMO-T005] どちらも無ければ evidence.timeout（既定 30000）', () => {
    expect(timeoutOf({}, {}, cfg)).toBe(30_000);
    expect(timeoutOf({}, null, evidenceConfigOf({ evidence: { timeout: 2000 } }))).toBe(2000);
  });
});

const SECRET = 'Server=db;Password=hunter22';

/** Fake providers by name (registered as built-ins of the resolver). */
function providers(seen: { ctx?: EvidenceContext; aborted?: boolean }): Map<string, Provider> {
  const p = (capture: (ctx: EvidenceContext) => Promise<unknown>, timeout?: number): Provider => ({
    kind: 'builtin',
    ...(timeout ? { timeout } : {}),
    capture: async (_args, ctx): Promise<CaptureResult> => {
      seen.ctx = ctx;
      return { outputs: await capture(ctx) };
    },
  });
  return new Map([
    ['text', p(async () => ({ kind: 'text', text: 'hello' }))],
    ['big', p(async () => ({ kind: 'text', text: 'x'.repeat(5000) }))],
    ['file', p(async (ctx) => {
      await fs.writeFile(path.join(ctx.outDir, 'a.png'), 'png');
      return [{ kind: 'image', path: 'a.png' }, { kind: 'table', columns: ['a'], rows: [[1]] }];
    })],
    ['slow', p((ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => ((seen.aborted = true), resolve({ kind: 'text', text: 'late' })))), 50)],
    ['throws', p(async () => {
      throw new Error(`接続できません：${SECRET}`);
    })],
    ['empty', p(async () => [])],
    ['shape', p(async () => ({ kind: 'table', columns: ['a'], rows: [[1, 2]] }))],
    ['outside', p(async () => ({ kind: 'file', path: '../x.txt' }))],
  ]);
}

const host = (platform: 'web' | 'wpf' = 'web'): EvidenceHost =>
  ({ platform, target: 'mock', screenshot: async () => {}, screenshotElement: async () => {}, mockTables: async () => null, hookContext: () => ({}) }) as unknown as EvidenceHost;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ddv-runner-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runner(seen: { ctx?: EvidenceContext; aborted?: boolean } = {}, key = 'T') {
  const config = evidenceConfigOf({ evidence: { maxBytes: 1024 } });
  return new EvidenceRunner({
    config,
    resolver: new ProviderResolver(providers(seen), {}, new Map()),
    store: new EvidenceStore(path.join(dir, 'trace'), key, config),
    testId: 'T',
    redactor: new Redactor([SECRET]),
    tmpRoot: path.join(dir, 'tmp'),
  });
}
const spec = (s: EvidenceSpecInput) => normalizeSpec(s);
const one = (s: EvidenceSpecInput, input: Record<string, string> = {}, seen = {}) => runner(seen).captureOne(spec(s), host(), new Map(Object.entries(input)), { step: 2, seq: 1 });

describe('1 つの指定の取得（CAPONE）', () => {
  it('[DD-EVRUN-CAPONE-P001][DD-EVRUN-CAPONE-P002][DD-EVRUN-CAPONE-T001][DD-EVRUN-CAPONE-T002][DD-EVRUN-CAPONE-T013][DD-EVRUN-CAPONE-T018][DD-EVRUN-CAPONE-T019] この時点に無い入力は失敗（warn・fail）', async () => {
    for (const onError of ['warn', 'fail'] as const) {
      const r = await one({ use: 'text', with: { id: { input: 'orderId' } }, onError });
      expect(r).toMatchObject({ status: onError === 'warn' ? 'warn' : 'failed', reason: 'text（判定後）— 入力 orderId はこの時点ではありません', files: [] });
    }
    expect(await one({ use: 'text', with: { id: { input: 'orderId' } } }, { orderId: 'A1' })).toMatchObject({ status: 'ok' });
  });

  it('[DD-EVRUN-CAPONE-P003][DD-EVRUN-CAPONE-P004][DD-EVRUN-CAPONE-T003][DD-EVRUN-CAPONE-T004][DD-EVRUN-CAPONE-T014] 登録されていない取得手段は失敗', async () => {
    for (const onError of ['warn', 'fail'] as const) {
      const r = await one({ use: 'nope', at: 'before', onError });
      expect(r).toMatchObject({ status: onError === 'warn' ? 'warn' : 'failed', reason: `nope（操作前）— ${unregisteredMessage('nope')}`, provider: 'hooks' });
    }
  });

  it('[DD-EVRUN-CAPONE-P005][DD-EVRUN-CAPONE-P006][DD-EVRUN-CAPONE-T005][DD-EVRUN-CAPONE-T006][DD-EVRUN-CAPONE-T007][DD-EVRUN-CAPONE-T015] 時間の上限を超えたら中止して失敗', async () => {
    for (const onError of ['warn', 'fail'] as const) {
      const seen: { aborted?: boolean } = {};
      const r = await one({ use: 'slow', onError }, {}, seen);
      expect(r).toMatchObject({ status: onError === 'warn' ? 'warn' : 'failed', reason: `slow（判定後）— ${timeoutMessage(50)}` });
      expect(seen.aborted).toBe(true);
    }
  });

  it('[DD-EVRUN-CAPONE-P007][DD-EVRUN-CAPONE-P008][DD-EVRUN-CAPONE-T008][DD-EVRUN-CAPONE-T016] 例外は文言を理由に（接続情報は伏せる）', async () => {
    for (const onError of ['warn', 'fail'] as const) {
      const r = await one({ use: 'throws', onError });
      expect(r).toMatchObject({ status: onError === 'warn' ? 'warn' : 'failed', reason: 'throws（判定後）— 接続できません：***' });
    }
  });

  it('[DD-EVRUN-CAPONE-P009][DD-EVRUN-CAPONE-P010][DD-EVRUN-CAPONE-T009][DD-EVRUN-CAPONE-T010][DD-EVRUN-CAPONE-T017] 出力が無い・形が不正なら失敗', async () => {
    for (const onError of ['warn', 'fail'] as const) {
      const status = onError === 'warn' ? 'warn' : 'failed';
      expect(await one({ use: 'empty', onError })).toMatchObject({ status, reason: `empty（判定後）— ${NO_OUTPUT}` });
      expect(await one({ use: 'shape', onError })).toMatchObject({ status, reason: `shape（判定後）— ${BAD_OUTPUT}` });
      expect(await one({ use: 'outside', onError })).toMatchObject({ status, reason: `outside（判定後）— ${BAD_OUTPUT}` });
    }
  });

  it('[DD-EVRUN-CAPONE-P011][DD-EVRUN-CAPONE-T011][DD-EVRUN-CAPONE-T012] 保存して status=ok（出力フォルダは片付ける）', async () => {
    const seen: { ctx?: EvidenceContext } = {};
    const r = await one({ use: 'file', label: '画面と表', with: { id: { input: 'k' } } }, { k: 'v' }, seen);
    expect(r).toMatchObject({ seq: 1, label: '画面と表', use: 'file', at: 'after', provider: 'hooks', status: 'ok' });
    expect(r.files.map((f) => f.path)).toEqual(['T/evidence/2-1-画面と表-1.png', 'T/evidence/2-1-画面と表-2.table.json']);
    expect(seen.ctx).toMatchObject({ platform: 'web', testId: 'T', step: 2, at: 'after', input: { k: 'v' } });
    expect(existsSync(seen.ctx!.outDir)).toBe(false);
  });
});

describe('ステップの結果（STEPRES）', () => {
  const step: Step = { click: 'a' };
  it('[DD-EVRUN-STEPRES-P001][DD-EVRUN-STEPRES-T001][DD-EVRUN-STEPRES-T002][DD-EVRUN-STEPRES-T003] 判定も証跡も失敗なら両方の文言', () => {
    const e = stepResult(step, 0, new StepError('notFound', 'ステップ 1: a が見つかりません', { key: 'a' }), ['x（判定後）— 失敗', 'y（操作前）— 失敗']);
    expect(e).toBeInstanceOf(StepError);
    expect((e as StepError).kind).toBe('notFound');
    expect(e!.message).toBe('ステップ 1: a が見つかりません\n証跡も失敗：x（判定後）— 失敗、y（操作前）— 失敗');
  });
  it('[DD-EVRUN-STEPRES-P002][DD-EVRUN-STEPRES-T004] 判定だけ失敗なら従来どおり', () => {
    const f = new Error('ステップ 1: x');
    expect(stepResult(step, 0, f, [])).toBe(f);
  });
  it('[DD-EVRUN-STEPRES-P003][DD-EVRUN-STEPRES-T005][DD-EVRUN-STEPRES-T006] 証跡だけ失敗なら StepError evidence', () => {
    const e = stepResult(step, 0, null, ['x（判定後）— 失敗']) as StepError;
    expect(e.kind).toBe('evidence');
    expect(e.message).toMatch(/: 証跡の取得に失敗しました：x（判定後）— 失敗$/);
  });
  it('[DD-EVRUN-STEPRES-P004][DD-EVRUN-STEPRES-T007] どちらも無ければ成功', () => {
    expect(stepResult(step, 0, null, [])).toBeNull();
  });
});

class FakeDriver implements Driver {
  log: string[] = [];
  fieldKind() {
    return 'text' as const;
  }
  fill(key: string, value: string | boolean) {
    this.log.push(`fill:${key}=${value}`);
  }
  click(key: string) {
    if (key === 'missing') throw new StepError('notFound', `${key} が見つかりません`, { key });
    this.log.push(`click:${key}`);
  }
  invoke() {}
  screen() {
    return 'List';
  }
  isVisible() {
    return true;
  }
  text() {
    return '';
  }
  count() {
    return 1;
  }
}

class FakeSession implements ScenarioSession {
  readonly target = 'mock' as const;
  readonly driver = new FakeDriver();
  constructor(readonly platform: 'web' | 'wpf' = 'web') {}
  async open() {}
  async capture(): Promise<Capture> {
    return { take: async () => ({ calls: [], db: [] }) };
  }
  async close() {}
  async screenshot() {}
  async screenshotElement() {}
  async mockTables() {
    return null;
  }
  hookContext() {
    return {};
  }
}

describe('ステップの証跡（BD-EVICAP-CAPTURE）', () => {
  let n = 0;
  async function run(steps: Step[], platform: 'web' | 'wpf' = 'web') {
    const id = `RUN-${++n}`;
    const traceDir = path.join(dir, 'runs', id);
    const scenario: Scenario = { id, title: 't', fixtures: [], start: 'List', steps };
    const rec = new TraceRecorder(traceDir, { runId: 'r', testId: id, title: 't', mock: 'm', target: 'mock', platform });
    const key = traceKey(id, platform);
    const config = evidenceConfigOf({ evidence: { maxBytes: 1024 } });
    const ev = new EvidenceRunner({
      config,
      resolver: new ProviderResolver(providers({}), {}, new Map()),
      store: new EvidenceStore(traceDir, key, config),
      testId: id,
      tmpRoot: path.join(dir, 'tmp'),
    });
    const session = new FakeSession(platform);
    const error = await runScenarioWith(session, scenario, { trace: rec, timeout: 100, evidence: ev }).then(
      () => null,
      (e: Error) => e,
    );
    const trace = JSON.parse(await fs.readFile(path.join(traceDir, `${key}.json`), 'utf8')) as TraceFile;
    return { error, trace, session };
  }

  it('[BD-EVICAP-CAPTURE-P001][BD-EVICAP-CAPTURE-T001][BD-EVICAP-CAPTURE-T002][BD-EVICAP-CAPTURE-S001] only の対象外のステップは取得せず skip を記録する', async () => {
    const { error, trace } = await run([{ click: 'a', only: 'wpf', evidence: [{ use: 'text' }, { use: 'nope', at: 'before' }] }]);
    expect(error).toBeNull();
    expect(trace.steps[0]).toMatchObject({ skipped: true, evidence: [{ seq: 1, use: 'nope', at: 'before', status: 'skipped', files: [] }, { seq: 2, use: 'text', at: 'after', status: 'skipped' }] });
  });

  it('[BD-EVICAP-CAPTURE-P002][BD-EVICAP-CAPTURE-T003][BD-EVICAP-CAPTURE-T004][BD-EVICAP-CAPTURE-T012][BD-EVICAP-CAPTURE-T013][BD-EVICAP-CAPTURE-S002][BD-EVICAP-CAPTURE-S003][BD-EVICAP-CAPTURE-S005][BD-EVICAP-CAPTURE-S014] 取得手段が見つからず warn なら警告として記録し、ステップは成功', async () => {
    const { error, trace, session } = await run([{ click: 'a', evidence: [{ use: 'nope', onError: 'warn' }] }, { click: 'b' }]);
    expect(error).toBeNull();
    expect(session.driver.log).toEqual(['click:a', 'click:b']);
    expect(trace.status).toBe('passed');
    expect(trace.steps[0]).toMatchObject({ ok: true, evidenceWarnings: 1, evidence: [{ status: 'warn', reason: `nope（判定後）— ${unregisteredMessage('nope')}` }] });
  });

  it('[BD-EVICAP-CAPTURE-P003][BD-EVICAP-CAPTURE-T014][BD-EVICAP-CAPTURE-S015] fail ならステップを失敗にしてテストを止める', async () => {
    const { error, trace, session } = await run([{ click: 'a', evidence: [{ use: 'nope' }] }, { click: 'b' }]);
    expect(error).toBeInstanceOf(StepError);
    expect(error!.message).toContain(`証跡の取得に失敗しました：nope（判定後）— ${unregisteredMessage('nope')}`);
    expect(session.driver.log).toEqual(['click:a']);
    expect(trace).toMatchObject({ status: 'failed', failedStep: 1 });
    expect(trace.steps[0]).toMatchObject({ ok: false, evidence: [{ status: 'failed' }] });
  });

  it('[BD-EVICAP-CAPTURE-P004][BD-EVICAP-CAPTURE-P005][BD-EVICAP-CAPTURE-T005][BD-EVICAP-CAPTURE-T006][BD-EVICAP-CAPTURE-S004][BD-EVICAP-CAPTURE-S006][BD-EVICAP-CAPTURE-S008] 時間の上限を超えたら warn・fail に従う', async () => {
    const warn = await run([{ click: 'a', evidence: [{ use: 'slow', onError: 'warn' }] }]);
    expect(warn.error).toBeNull();
    expect(warn.trace.steps[0]).toMatchObject({ ok: true, evidence: [{ status: 'warn', reason: `slow（判定後）— ${timeoutMessage(50)}` }] });
    const fail = await run([{ click: 'a', evidence: [{ use: 'slow', at: 'before' }] }]);
    expect(fail.error!.message).toContain(timeoutMessage(50));
    expect(fail.trace.steps[0]).toMatchObject({ ok: false, evidence: [{ status: 'failed', at: 'before' }] });
  });

  it('[BD-EVICAP-CAPTURE-P006][BD-EVICAP-CAPTURE-P007][BD-EVICAP-CAPTURE-T007][BD-EVICAP-CAPTURE-T008][BD-EVICAP-CAPTURE-S007][BD-EVICAP-CAPTURE-S009][BD-EVICAP-CAPTURE-S011] 取得手段が失敗したら warn・fail に従う（判定の失敗にも理由を加える）', async () => {
    const warn = await run([{ click: 'a', evidence: [{ use: 'throws', onError: 'warn' }] }]);
    expect(warn.error).toBeNull();
    expect(warn.trace.steps[0].evidence?.[0].status).toBe('warn');
    const both = await run([{ click: 'missing', evidence: [{ use: 'throws' }] }]);
    expect(both.error!.message).toMatch(/missing が見つかりません\n証跡も失敗：throws（判定後）— 接続できません/);
    expect((both.error as StepError).kind).toBe('notFound');
  });

  it('[BD-EVICAP-CAPTURE-P008][BD-EVICAP-CAPTURE-T009][BD-EVICAP-CAPTURE-T010][BD-EVICAP-CAPTURE-S010][BD-EVICAP-CAPTURE-S012] 上限を超える大きさは切って保存し、切った旨を記録する', async () => {
    const { error, trace } = await run([{ click: 'a', evidence: [{ use: 'big' }] }]);
    expect(error).toBeNull();
    expect(trace.steps[0].evidence?.[0]).toMatchObject({ status: 'ok', truncated: true, files: [{ kind: 'text', bytes: 1024 }] });
  });

  it('[BD-EVICAP-CAPTURE-P009][BD-EVICAP-CAPTURE-T011][BD-EVICAP-CAPTURE-S013] 以内ならそのまま保存（操作前・判定後の順に seq）', async () => {
    const { error, trace } = await run([{ click: 'a', evidence: [{ use: 'text' }, { use: 'file', at: 'before' }] }]);
    expect(error).toBeNull();
    const ev = trace.steps[0].evidence!;
    expect(ev.map((e) => [e.seq, e.use, e.at, e.status, e.truncated])).toEqual([
      [1, 'file', 'before', 'ok', undefined],
      [2, 'text', 'after', 'ok', undefined],
    ]);
    expect(ev[1].files[0].path).toBe(`${trace.testId}/evidence/1-2-text.txt`);
    expect(await fs.readFile(path.join(dir, 'runs', trace.testId, ...ev[1].files[0].path.split('/')), 'utf8')).toBe('hello');
  });
});
