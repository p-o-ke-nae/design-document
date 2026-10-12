import { describe, expect, it } from 'vitest';
import type { TraceFile, TraceStep } from '@ddv/mock/trace-format';
import { acceptsArrowKeys, callStatus, describeAction, initialSelection, reduceTraceView, startTrace, type TraceViewState } from './trace-view.ts';

const TID = ['BD', 'ORDER', 'SCREEN', 'P001'].join('-');
const step = (index: number, ok = true): TraceStep => ({ index, event: `e${index}`, screenBefore: null, screenAfter: null, expects: [], ok, durationMs: 1, calls: [], db: [] });
const trace = (p: Partial<TraceFile> = {}): TraceFile => ({
  version: 1,
  runId: 'r1',
  testId: TID,
  title: 't',
  mock: 'order',
  target: 'mock',
  startedAt: '2025-01-01T00:00:00.000Z',
  durationMs: 10,
  status: 'passed',
  steps: [step(1), step(2), step(3)],
  ...p,
});
const KEY = { runId: 'r1', testId: TID };
const KEY2 = { runId: 'r2', testId: TID };

describe('初めに選ぶステップ（DD-TRVIEW-INITIAL）', () => {
  it('[DD-TRVIEW-INITIAL-P001] [DD-TRVIEW-INITIAL-T001] [DD-TRVIEW-INITIAL-T002] status が failed でなければステップ 1', () => {
    expect(initialSelection(trace())).toBe(1);
  });

  it('[DD-TRVIEW-INITIAL-P002] [DD-TRVIEW-INITIAL-T003] [DD-TRVIEW-INITIAL-T004] failed で failedStep が 1 以上ならそのステップ', () => {
    expect(initialSelection(trace({ status: 'failed', failedStep: 2, steps: [step(1), step(2, false)] }))).toBe(2);
  });

  it('[DD-TRVIEW-INITIAL-P003] [DD-TRVIEW-INITIAL-T005] failed で failedStep が 0 なら選択なし。steps が空でも選択なし', () => {
    expect(initialSelection(trace({ status: 'failed', failedStep: 0, steps: [] }))).toBeNull();
    expect(initialSelection(trace({ status: 'failed', failedStep: 0 }))).toBeNull();
    expect(initialSelection(trace({ steps: [] }))).toBeNull();
  });
});

describe('ステップの選択（DD-TRVIEW-SELECT）', () => {
  const shown = (p: Partial<TraceFile> = {}) => reduceTraceView(startTrace(KEY), { type: 'fetched', key: KEY, trace: trace(p) }) as Extract<TraceViewState, { kind: 'Shown' }>;
  const none = () => reduceTraceView(startTrace(KEY), { type: 'fetched', key: KEY, code: 'pruned', message: 'm' });

  it('[DD-TRVIEW-SELECT-T001] 開始すると読み込み中', () => {
    expect(startTrace(KEY)).toEqual({ kind: 'Loading', key: KEY });
  });

  it('[DD-TRVIEW-SELECT-T002] 読み込み中で取得（あり）なら表示し、初めのステップを選ぶ', () => {
    const s = shown({ status: 'failed', failedStep: 3 });
    expect(s).toMatchObject({ kind: 'Shown', selected: 3 });
  });

  it('[DD-TRVIEW-SELECT-T003] 読み込み中で取得（なし）ならトレースなし', () => {
    expect(none()).toEqual({ kind: 'None', key: KEY, code: 'pruned', message: 'm' });
  });

  it('[DD-TRVIEW-SELECT-T004] 表示でステップを選ぶと選択が変わる（無いステップは無視）', () => {
    const s = shown();
    expect(reduceTraceView(s, { type: 'select', index: 3 })).toMatchObject({ kind: 'Shown', selected: 3 });
    expect(reduceTraceView(s, { type: 'select', index: 9 })).toBe(s);
  });

  it('[DD-TRVIEW-SELECT-T005] 表示で前（先頭でない）は 1 つ前へ。先頭では無視', () => {
    const s = reduceTraceView(shown(), { type: 'select', index: 2 });
    expect(reduceTraceView(s, { type: 'prev' })).toMatchObject({ selected: 1 });
    const first = shown();
    expect(reduceTraceView(first, { type: 'prev' })).toBe(first);
  });

  it('[DD-TRVIEW-SELECT-T006] 表示で次（末尾でない）は 1 つ後へ。末尾では無視。選択なしからは先頭へ', () => {
    expect(reduceTraceView(shown(), { type: 'next' })).toMatchObject({ selected: 2 });
    const last = reduceTraceView(shown(), { type: 'select', index: 3 });
    expect(reduceTraceView(last, { type: 'next' })).toBe(last);
    const nosel = shown({ status: 'failed', failedStep: 0 });
    expect(nosel.selected).toBeNull();
    expect(reduceTraceView(nosel, { type: 'next' })).toMatchObject({ selected: 1 });
    expect(reduceTraceView(nosel, { type: 'prev' })).toBe(nosel);
  });

  it('[DD-TRVIEW-SELECT-T007] 表示で別のトレースを開くと読み込み中（同じトレースなら何もしない）', () => {
    const s = shown();
    expect(reduceTraceView(s, { type: 'open', key: KEY2 })).toEqual({ kind: 'Loading', key: KEY2 });
    expect(reduceTraceView(s, { type: 'open', key: KEY })).toBe(s);
  });

  it('[DD-TRVIEW-SELECT-T008] トレースなしで別のトレースを開くと読み込み中', () => {
    expect(reduceTraceView(none(), { type: 'open', key: KEY2 })).toEqual({ kind: 'Loading', key: KEY2 });
  });

  it('[DD-TRVIEW-SELECT-X001] [DD-TRVIEW-SELECT-X002] [DD-TRVIEW-SELECT-X003] 読み込み中はステップを選ぶ・前・次を無視', () => {
    const s = startTrace(KEY);
    for (const e of [{ type: 'select', index: 1 }, { type: 'prev' }, { type: 'next' }] as const) expect(reduceTraceView(s, e)).toBe(s);
  });

  it('[DD-TRVIEW-SELECT-X004] 読み込み中に別のトレースを開くと読み込み中のまま新しい方を待ち、古い応答は捨てる', () => {
    const s = reduceTraceView(startTrace(KEY), { type: 'open', key: KEY2 });
    expect(s).toEqual({ kind: 'Loading', key: KEY2 });
    expect(reduceTraceView(s, { type: 'fetched', key: KEY, trace: trace() })).toBe(s);
    expect(reduceTraceView(s, { type: 'fetched', key: KEY2, trace: trace({ runId: 'r2' }) })).toMatchObject({ kind: 'Shown', key: KEY2 });
  });

  it('[DD-TRVIEW-SELECT-X005] 表示では取得を無視（トレースは 1 回だけ取得）', () => {
    const s = shown();
    expect(reduceTraceView(s, { type: 'fetched', key: KEY, trace: trace({ status: 'failed', failedStep: 2 }) })).toBe(s);
  });

  it('[DD-TRVIEW-SELECT-X006] [DD-TRVIEW-SELECT-X007] [DD-TRVIEW-SELECT-X008] [DD-TRVIEW-SELECT-X009] トレースなしでは取得・ステップを選ぶ・前・次を無視', () => {
    const s = none();
    for (const e of [{ type: 'fetched', key: KEY, trace: trace() }, { type: 'select', index: 1 }, { type: 'prev' }, { type: 'next' }] as const) expect(reduceTraceView(s, e)).toBe(s);
  });

  it('←・→ は入力欄にフォーカスが無いときだけ', () => {
    expect(acceptsArrowKeys(null)).toBe(true);
    expect(acceptsArrowKeys({ tagName: 'BUTTON', isContentEditable: false } as unknown as EventTarget)).toBe(true);
    expect(acceptsArrowKeys({ tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(acceptsArrowKeys({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(false);
  });
});

describe('表示の文言', () => {
  it('操作と通信の状態', () => {
    expect(describeAction({ input: { qty: 2, name: 'a' }, click: 'next' })).toBe('入力 qty：2、name：a → クリック next');
    expect(describeAction({})).toBe('（操作なし）');
    expect([callStatus(200), callStatus(0), callStatus(-1)]).toEqual(['200', '失敗', '未完了']);
  });
});
