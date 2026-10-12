import type { TraceFile } from '@ddv/mock/trace-format';

export type { ApiCall, DbChange, ExpectObservation, LiveStepTrace, TraceFile, TraceStep } from '@ddv/mock/trace-format';

/** Step to select when a trace opens (DD-TRVIEW-INITIAL); null = 選択なし (the error before the steps is shown). */
export function initialSelection(trace: Pick<TraceFile, 'status' | 'failedStep' | 'steps'>): number | null {
  if (!trace.steps.length) return null;
  if (trace.status !== 'failed') return trace.steps[0].index;
  return trace.failedStep !== undefined && trace.failedStep >= 1 ? trace.failedStep : null;
}

/** A trace as served by the API (with the run's commit). */
export type TraceDoc = TraceFile & { commit?: string; dirty?: boolean };

export interface TraceKey {
  runId: string;
  testId: string;
}

/** 読み込み中 / 表示 / トレースなし (DD-TRVIEW-SELECT). */
export type TraceViewState =
  | { kind: 'Loading'; key: TraceKey }
  | { kind: 'Shown'; key: TraceKey; trace: TraceDoc; selected: number | null }
  | { kind: 'None'; key: TraceKey; code: string; message: string };

export type TraceViewEvent =
  | { type: 'fetched'; key: TraceKey; trace: TraceDoc }
  | { type: 'fetched'; key: TraceKey; code: string; message: string }
  | { type: 'select'; index: number }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'open'; key: TraceKey };

const same = (a: TraceKey, b: TraceKey) => a.runId === b.runId && a.testId === b.testId;

export function startTrace(key: TraceKey): TraceViewState {
  return { kind: 'Loading', key };
}

/** Next state; returns the same object when the event is ignored. */
export function reduceTraceView(s: TraceViewState, e: TraceViewEvent): TraceViewState {
  switch (e.type) {
    case 'open':
      // 読み込み中 で別のトレース: keep loading, but for the new key (the late response of the old one is dropped)
      if (same(s.key, e.key)) return s;
      return { kind: 'Loading', key: e.key };
    case 'fetched':
      if (s.kind !== 'Loading' || !same(s.key, e.key)) return s;
      return 'trace' in e ? { kind: 'Shown', key: s.key, trace: e.trace, selected: initialSelection(e.trace) } : { kind: 'None', key: s.key, code: e.code, message: e.message };
    case 'select':
      if (s.kind !== 'Shown' || !s.trace.steps.some((st) => st.index === e.index) || s.selected === e.index) return s;
      return { ...s, selected: e.index };
    case 'prev':
    case 'next': {
      if (s.kind !== 'Shown' || !s.trace.steps.length) return s;
      const steps = s.trace.steps;
      const at = steps.findIndex((st) => st.index === s.selected);
      if (at < 0) return e.type === 'next' ? { ...s, selected: steps[0].index } : s;
      const to = e.type === 'prev' ? at - 1 : at + 1;
      if (to < 0 || to >= steps.length) return s;
      return { ...s, selected: steps[to].index };
    }
  }
}

/** Whether ← / → may move the selection (no input field has the focus). */
export function acceptsArrowKeys(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return true;
  return !(/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

/** 「入力 a：1、b：2」「クリック x」「操作 y」. */
export function describeAction(step: { input?: Record<string, unknown>; click?: string; do?: string }): string {
  const parts: string[] = [];
  const inputs = Object.entries(step.input ?? {});
  if (inputs.length) parts.push(`入力 ${inputs.map(([k, v]) => `${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`).join('、')}`);
  if (step.click !== undefined) parts.push(`クリック ${step.click}`);
  if (step.do !== undefined) parts.push(`操作 ${step.do}`);
  return parts.length ? parts.join(' → ') : '（操作なし）';
}

/** Status column of an API call: 0 = 失敗, -1 = 未完了. */
export function callStatus(status: number): string {
  return status === 0 ? '失敗' : status === -1 ? '未完了' : String(status);
}

export function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 7) : '';
}

/** Whether a test id is linked to a scenario (`scenarios/*.yaml`), i.e. its E2E may have a trace. */
export function scenarioLinked(links: Array<{ file: string }>): boolean {
  return links.some((l) => /(^|\/)scenarios\/[^/]+\.ya?ml$/.test(l.file.replace(/\\/g, '/')));
}

let inAppNavigations = 0;
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => inAppNavigations++);

/** 「戻る」: the screen the trace was opened from (when it was opened inside the viewer), else the tests list. */
export function goBack(fallback: string): void {
  if (inAppNavigations > 0) history.back();
  else location.hash = fallback;
}
