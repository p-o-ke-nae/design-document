import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { observeExpect, type Driver } from './step.ts';
import { clipBody, diffTables, ORDER_ERROR, recorderFor, traceDirOf, TraceRecorder, type StepTrace, type TraceFile } from './trace.ts';
import type { Step } from './types.ts';

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-trace-'));
  tmps.push(d);
  return path.join(d, 'run-1');
}

const ID = ['BD', 'ORDER', 'SCREEN', 'P001'].join('-');
const meta = { runId: 'run-1', testId: ID, title: '注文する', mock: 'order', target: 'mock' as const };
const step = (event: string): Step => ({ event, click: event, expect: { screen: 'A' } });
const ok = (extra: Partial<StepTrace> = {}): StepTrace => ({ screenAfter: 'A', expects: [], ok: true, durationMs: 5, calls: [], db: [], ...extra });
const read = async (dir: string) => JSON.parse(await fs.readFile(path.join(dir, `${ID}.json`), 'utf8')) as TraceFile;

describe('本文の切り詰め（DD-TRREC-CLIP）', () => {
  it('[DD-TRREC-CLIP-P001] [DD-TRREC-CLIP-T001] [DD-TRREC-CLIP-T002] 本文が無いときは undefined', () => {
    expect(clipBody(undefined)).toBeUndefined();
    expect(clipBody(null)).toBeUndefined();
  });

  it('[DD-TRREC-CLIP-P002] [DD-TRREC-CLIP-T003] [DD-TRREC-CLIP-T004] UTF-8 で limit バイト以下ならそのまま', () => {
    expect(clipBody('{"a":1}', 7)).toEqual({ body: '{"a":1}' });
    expect(clipBody('あい', 6)).toEqual({ body: 'あい' });
    expect(clipBody('')).toEqual({ body: '' });
  });

  it('[DD-TRREC-CLIP-P003] [DD-TRREC-CLIP-T005] 超えるときは文字の境界で切り truncated を付ける（既定 64KB）', () => {
    expect(clipBody('あいう', 7)).toEqual({ body: 'あい', truncated: true });
    expect(clipBody('ab😀c', 5)).toEqual({ body: 'ab', truncated: true });
    const big = clipBody('x'.repeat(64 * 1024 + 10));
    expect(big?.body.length).toBe(64 * 1024);
    expect(big?.truncated).toBe(true);
  });
});

describe('DB の変化（DD-TRREC-DBDIFF）', () => {
  it('[DD-TRREC-DBDIFF-P001] [DD-TRREC-DBDIFF-T001] [DD-TRREC-DBDIFF-T002] [DD-TRREC-DBDIFF-T003] before に無く after にある行は added', () => {
    expect(diffTables({ orders: [] }, { orders: [{ id: 1, total: 3 }] })).toEqual([{ table: 'orders', kind: 'added', key: '1', after: { id: 1, total: 3 } }]);
  });

  it('[DD-TRREC-DBDIFF-P002] [DD-TRREC-DBDIFF-T004] [DD-TRREC-DBDIFF-T005] before にあり after に無い行は removed', () => {
    expect(diffTables({ orders: [{ id: 1 }] }, {})).toEqual([{ table: 'orders', kind: 'removed', key: '1', before: { id: 1 } }]);
  });

  it('[DD-TRREC-DBDIFF-P003] [DD-TRREC-DBDIFF-T006] [DD-TRREC-DBDIFF-T007] JSON として同じ行は記録しない', () => {
    expect(diffTables({ orders: [{ id: 1, a: [1] }] }, { orders: [{ id: 1, a: [1] }] })).toEqual([]);
  });

  it('[DD-TRREC-DBDIFF-P004] [DD-TRREC-DBDIFF-T008] 違う行は changed（before と after）。並びはテーブル名・種類・キーの順、キーは TableDef.key、無ければ #位置', () => {
    const before = { z: [{ id: 1, v: 1 }], items: [{ code: 'b', n: 1 }, { code: 'a', n: 1 }, { code: 'c', n: 1 }], logs: [{ m: 'x' }] };
    const after = { z: [{ id: 1, v: 2 }], items: [{ code: 'c', n: 1 }, { code: 'b', n: 2 }, { code: 'a', n: 3 }, { code: 'd', n: 1 }], logs: [{ m: 'y' }, { m: 'z' }] };
    const r = diffTables(before, after, { items: 'code' });
    expect(r.map((c) => `${c.table}:${c.kind}:${c.key}`)).toEqual(['items:added:d', 'items:changed:a', 'items:changed:b', 'logs:added:#1', 'logs:changed:#0', 'z:changed:1']);
    expect(r.find((c) => c.table === 'z')).toEqual({ table: 'z', kind: 'changed', key: '1', before: { id: 1, v: 1 }, after: { id: 1, v: 2 } });
    expect(diffTables({ t: [{ id: 2 }, { id: 1 }] }, {}).map((c) => c.key)).toEqual(['1', '2']);
  });
});

describe('記録の有効化（DD-TRREC-ENABLE）', () => {
  it('[DD-TRREC-ENABLE-P002] [DD-TRREC-ENABLE-T004] [DD-TRREC-ENABLE-T005] DDV_TRACE_DIR が未設定・空なら traceDirOf は null（記録しない）', () => {
    expect(traceDirOf({})).toBeNull();
    expect(traceDirOf({ DDV_TRACE_DIR: '  ' })).toBeNull();
  });

  it('[DD-TRREC-ENABLE-P003] [DD-TRREC-ENABLE-T006] traceDirOf があればテストごとに TraceRecorder を作る（runId はディレクトリ名、ID はタイトルから）', () => {
    const dir = traceDirOf({ DDV_TRACE_DIR: path.join('.ddv', 'traces', 'run-9') })!;
    expect(path.isAbsolute(dir)).toBe(true);
    const rec = recorderFor(dir, `[${ID}] 注文する`, 'order', 'app')!;
    expect(rec.trace).toMatchObject({ version: 1, runId: 'run-9', testId: ID, title: '注文する', mock: 'order', target: 'app', status: 'passed', steps: [] });
    expect(recorderFor(dir, 'ID の無いテスト', 'order', 'mock')).toBeUndefined();
  });
});

describe('TraceRecorder（DD-TRREC-RECORDER）', () => {
  it('[DD-TRREC-RECORDER-P001] [DD-TRREC-RECORDER-T001] [DD-TRREC-RECORDER-T002] [DD-TRREC-RECORDER-T003] [DD-TRREC-RECORDER-T004] [DD-TRREC-RECORDER-T007] 成功のステップの後に失敗したステップで書き込む', async () => {
    const dir = await tmp();
    const rec = new TraceRecorder(dir, meta);
    rec.beginStep(1, { event: '入力', input: { qty: 2 }, expect: { screen: 'A' } }, 'Start');
    await rec.endStep(ok({ screenshot: `${ID}/1.png` }));
    rec.beginStep(2, step('次へ'), 'A');
    await rec.endStep(ok({ ok: false, error: 'ステップ 2（次へ）: 期待値と一致しません', screenAfter: 'A' }));
    const f = await read(dir);
    expect(f).toMatchObject({ version: 1, runId: 'run-1', testId: ID, status: 'failed', failedStep: 2, error: 'ステップ 2（次へ）: 期待値と一致しません' });
    expect(f.steps).toHaveLength(2);
    expect(f.steps[0]).toMatchObject({ index: 1, event: '入力', input: { qty: 2 }, screenBefore: 'Start', screenAfter: 'A', ok: true, screenshot: `${ID}/1.png` });
    expect(f.steps[1]).toMatchObject({ index: 2, click: '次へ', ok: false });
    expect(f.steps[1].screenshot).toBeUndefined();
    expect(await fs.readdir(dir)).toEqual([`${ID}.json`]);
  });

  it('[DD-TRREC-RECORDER-P002] [DD-TRREC-RECORDER-T005] 全ステップが成功したら write で passed を書く', async () => {
    const dir = await tmp();
    const rec = new TraceRecorder(dir, meta);
    rec.beginStep(1, step('次へ'), 'Start');
    await rec.endStep(ok());
    await rec.write();
    const f = await read(dir);
    expect(f.status).toBe('passed');
    expect(f.failedStep).toBeUndefined();
    expect(f.steps.map((s) => s.index)).toEqual([1]);
    expect(f.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('[DD-TRREC-RECORDER-P003] [DD-TRREC-RECORDER-T006] ステップの後でも fail は failedStep 0・steps 空で書く', async () => {
    const dir = await tmp();
    const rec = new TraceRecorder(dir, meta);
    rec.beginStep(1, step('次へ'), 'Start');
    await rec.endStep(ok());
    await rec.fail('runtime が読み込まれません');
    expect(await read(dir)).toMatchObject({ status: 'failed', failedStep: 0, error: 'runtime が読み込まれません', steps: [] });
  });

  it('[DD-TRREC-RECORDER-P004] 最初のステップで失敗', async () => {
    const dir = await tmp();
    const rec = new TraceRecorder(dir, meta);
    rec.beginStep(1, step('次へ'), null);
    await rec.endStep(ok({ ok: false, error: 'x' }));
    expect(await read(dir)).toMatchObject({ status: 'failed', failedStep: 1 });
  });

  it('[DD-TRREC-RECORDER-P005] ステップの無いシナリオは write だけ', async () => {
    const dir = await tmp();
    await new TraceRecorder(dir, meta).write();
    expect(await read(dir)).toMatchObject({ status: 'passed', steps: [] });
  });

  it('[DD-TRREC-RECORDER-P006] ステップの前の失敗は fail（ディレクトリが無ければ作る）', async () => {
    const dir = path.join(await tmp(), 'nested');
    await new TraceRecorder(dir, meta).fail('boom');
    expect(await read(dir)).toMatchObject({ failedStep: 0, steps: [], error: 'boom' });
  });

  it('[DD-TRREC-RECORDER-X001] [DD-TRREC-RECORDER-X002] [DD-TRREC-RECORDER-X003] [DD-TRREC-RECORDER-X004] 待機での endStep、ステップ記録中の beginStep・write・fail は順序の誤り', async () => {
    const dir = await tmp();
    const rec = new TraceRecorder(dir, meta);
    await expect(rec.endStep(ok())).rejects.toThrow(ORDER_ERROR);
    rec.beginStep(1, step('次へ'), null);
    expect(() => rec.beginStep(2, step('次へ'), null)).toThrow(ORDER_ERROR);
    await expect(rec.write()).rejects.toThrow(ORDER_ERROR);
    await expect(rec.fail('x')).rejects.toThrow(ORDER_ERROR);
    await expect(fs.stat(dir)).rejects.toThrow();
    await rec.endStep(ok());
    await rec.write();
    expect(await read(dir)).toMatchObject({ status: 'passed' });
  });

  it('[DD-TRREC-RECORDER-X005] [DD-TRREC-RECORDER-X006] [DD-TRREC-RECORDER-X007] [DD-TRREC-RECORDER-X008] 書き込み済みでは beginStep・endStep・write・fail は順序の誤り', async () => {
    const dir = await tmp();
    const rec = new TraceRecorder(dir, meta);
    await rec.write();
    expect(() => rec.beginStep(1, step('次へ'), null)).toThrow(ORDER_ERROR);
    await expect(rec.endStep(ok())).rejects.toThrow(ORDER_ERROR);
    await expect(rec.write()).rejects.toThrow(ORDER_ERROR);
    await expect(rec.fail('x')).rejects.toThrow(ORDER_ERROR);
  });
});

describe('observeExpect', () => {
  it('expect の各項目を 1 回だけ評価し、解決できない項目は actual: null', async () => {
    let calls = 0;
    const driver: Driver = {
      fieldKind: () => 'text',
      fill: () => {},
      click: () => {},
      invoke: () => {},
      screen: () => {
        calls++;
        return 'Confirm';
      },
      isVisible: (k) => {
        if (k === 'missing') throw new Error('not found');
        return k === 'shown';
      },
      text: (k) => (k === 'total' ? ' 合計  3,000 円 ' : null),
      count: () => 2,
    };
    const r = await observeExpect(driver, { screen: 'Input', visible: ['shown', 'missing'], hidden: ['gone', 'shown'], text: { total: '合計 3,000 円', none: 'x' }, count: { items: 2 } });
    expect(calls).toBe(1);
    expect(r).toEqual([
      { kind: 'screen', key: '', expected: 'Input', actual: 'Confirm', ok: false },
      { kind: 'visible', key: 'shown', expected: true, actual: true, ok: true },
      { kind: 'visible', key: 'missing', expected: true, actual: null, ok: false },
      { kind: 'hidden', key: 'gone', expected: false, actual: false, ok: true },
      { kind: 'hidden', key: 'shown', expected: false, actual: true, ok: false },
      { kind: 'text', key: 'total', expected: '合計 3,000 円', actual: ' 合計  3,000 円 ', ok: true },
      { kind: 'text', key: 'none', expected: 'x', actual: null, ok: false },
      { kind: 'count', key: 'items', expected: 2, actual: 2, ok: true },
    ]);
  });
});
