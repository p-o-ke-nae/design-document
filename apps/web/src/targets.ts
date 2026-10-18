// Target selection, run opening and platform badges (platform-results.md「実行の始め方」「接続先の選択の状態」「前回の選択」「バッジの表示」). Pure.
import { parseResultKey, sortPlatforms, type Platform } from '@ddv/services';
import { scenarioLinked } from './trace-view.ts';

export interface Target {
  name: string;
  platform: Platform;
  target: string;
  available: boolean;
  code?: string;
  reason?: string;
}

export const NO_TARGET_MESSAGE = '接続先を選んでください';
export const DESKTOP_WARNING = 'デスクトップアプリの操作中はマウス・キーボードに触れないでください（前面のウィンドウを操作しています）。';
export const HOSTED_TARGET_REASON = 'デスクトップアプリの実行はローカル版（Windows）で行います';

/** Pages edition (BD-DESKRUN-GATE: Pages 版): the config's targets; desktop targets are not runnable here. */
export function hostedTargets(runners: Array<{ name: string; type: string; scenarios?: unknown; platform?: Platform; app?: { path?: string } }>, mocksRoot: string): Target[] {
  return runners
    .filter((r) => (r.type === 'playwright' && !!r.scenarios) || r.type === 'flaui')
    .map((r) => {
      const platform: Platform = r.platform ?? 'web';
      if (platform === 'web') return { name: r.name, platform, target: `モック（${mocksRoot}）`, available: true };
      return { name: r.name, platform, target: r.app?.path ?? '', available: false, code: 'hosted', reason: HOSTED_TARGET_REASON };
    });
}

/** DD-PLATRES-RUNOPEN: open the target selection only when a scenario-linked id is run and there are 2+ targets. */
export function shouldOpenTargetSelect(ids: string[], cases: Array<{ id: string; links: Array<{ file: string }> }>, targetCount: number): boolean {
  const wanted = new Set(ids);
  const scenario = cases.some((c) => wanted.has(c.id) && scenarioLinked(c.links));
  if (!scenario) return false;
  return targetCount >= 2;
}

/** Number of the ids that are linked to a scenario (the description of the dialog). */
export function scenarioCount(ids: string[], cases: Array<{ id: string; links: Array<{ file: string }> }>): number {
  const wanted = new Set(ids);
  return cases.filter((c) => wanted.has(c.id) && scenarioLinked(c.links)).length;
}

/** 前回の選択: the saved names still available; else the available web targets (first one); else none. */
export function initialTargets(targets: Target[], saved: string[] | null | undefined): string[] {
  const usable = new Set(targets.filter((t) => t.available).map((t) => t.name));
  const kept = (saved ?? []).filter((n) => usable.has(n));
  if (kept.length) return [...new Set(kept)];
  const web = targets.find((t) => t.available && t.platform === 'web');
  return web ? [web.name] : [];
}

export const targetStorageKey = (workspaceId: string) => `ddv.targets.${workspaceId}`;

export function loadSavedTargets(storage: Pick<Storage, 'getItem'>, workspaceId: string): string[] | null {
  try {
    const v = JSON.parse(storage.getItem(targetStorageKey(workspaceId)) ?? 'null') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

export function saveTargets(storage: Pick<Storage, 'setItem'>, workspaceId: string, names: string[]): void {
  try {
    storage.setItem(targetStorageKey(workspaceId), JSON.stringify(names));
  } catch {
    /* storage full / denied: the next open falls back to the default */
  }
}

// ---- 接続先の選択の状態（DD-PLATRES-TSEL） ----

export type TargetSelectState =
  | { kind: 'Loading' }
  | { kind: 'Choosing'; targets: Target[]; selected: string[]; error: string }
  | { kind: 'LoadError'; error: string }
  | { kind: 'Starting'; targets: Target[]; selected: string[] }
  | { kind: 'Closed'; runId?: string; selected?: string[] };

export type TargetSelectEvent =
  | { type: 'loaded'; targets: Target[]; saved?: string[] | null }
  | { type: 'loadFailed'; error: string }
  | { type: 'reopen' }
  | { type: 'start' }
  | { type: 'rejected'; error: string }
  | { type: 'started'; runId: string }
  | { type: 'cancel' }
  | { type: 'toggle'; name: string };

export function openTargetSelect(): TargetSelectState {
  return { kind: 'Loading' };
}

/** Next state; the same object when the event is not accepted in that state (the buttons are disabled). */
export function targetSelectReducer(s: TargetSelectState, e: TargetSelectEvent): TargetSelectState {
  switch (s.kind) {
    case 'Loading':
      if (e.type === 'loaded') return { kind: 'Choosing', targets: e.targets, selected: initialTargets(e.targets, e.saved), error: '' };
      if (e.type === 'loadFailed') return { kind: 'LoadError', error: `接続先を読み込めません: ${e.error}` };
      return s;
    case 'LoadError':
      if (e.type === 'reopen') return { kind: 'Loading' };
      if (e.type === 'cancel') return { kind: 'Closed' };
      return s;
    case 'Choosing':
      if (e.type === 'toggle') {
        const t = s.targets.find((x) => x.name === e.name);
        if (!t?.available) return s;
        const selected = s.selected.includes(e.name) ? s.selected.filter((n) => n !== e.name) : [...s.selected, e.name];
        return { ...s, selected: s.targets.map((x) => x.name).filter((n) => selected.includes(n)), error: '' };
      }
      if (e.type === 'start') return s.selected.length ? { kind: 'Starting', targets: s.targets, selected: s.selected } : { ...s, error: NO_TARGET_MESSAGE };
      if (e.type === 'cancel') return { kind: 'Closed' };
      return s;
    case 'Starting':
      if (e.type === 'rejected') return { kind: 'Choosing', targets: s.targets, selected: s.selected, error: e.error };
      if (e.type === 'started') return { kind: 'Closed', runId: e.runId, selected: s.selected };
      return s;
    case 'Closed':
      return s;
  }
}

/** The warning while running: shown only when a desktop target is chosen. */
export function desktopWarning(targets: Target[], selected: string[]): string | null {
  return targets.some((t) => selected.includes(t.name) && t.platform !== 'web') ? DESKTOP_WARNING : null;
}

export interface TargetProgress {
  name: string;
  state: '実行中' | '待ち' | '完了';
}

/** 接続先の進捗 from the run log: the runner header `── <name> (…) ──` starts a runner, the next header (or the end) finishes it. */
export function targetProgress(names: string[], log: string[], finished: boolean): TargetProgress[] {
  const started: string[] = [];
  for (const line of log) {
    const m = /^── (\S+) \(/.exec(line);
    if (m && names.includes(m[1]) && !started.includes(m[1])) started.push(m[1]);
  }
  const current = finished ? undefined : started[started.length - 1];
  return names.map((name) => ({ name, state: name === current ? '実行中' : started.includes(name) || finished ? '完了' : '待ち' }));
}

// ---- バッジ（DD-PLATRES-BADGE） ----

export interface BadgeResult {
  status: 'passed' | 'failed' | 'skipped' | 'error';
  runId?: string;
  trace?: boolean;
  message?: string;
}

export interface Badge {
  platform: Platform;
  /** ✓ / ✗ / – */
  mark: '✓' | '✗' | '–';
  label: string;
  /** Link to the trace; null = not clickable. */
  trace: { runId: string; testId: string; platform: Platform } | null;
  title: string;
}

/** Latest results of one test id per platform, from the `/api/results/latest` map. */
export function resultsByPlatform<R>(latest: Record<string, R>, testId: string): Partial<Record<Platform, R>> {
  const out: Partial<Record<Platform, R>> = {};
  for (const [key, r] of Object.entries(latest)) {
    const k = parseResultKey(key);
    if (k.testId === testId) out[k.platform] = r;
  }
  return out;
}

/** Badges of a row; null = 従来の表示 (only web, or nothing). */
export function badgesFor(testId: string, targetPlatforms: Iterable<string>, results: Partial<Record<Platform, BadgeResult>>): Badge[] | null {
  const platforms = sortPlatforms([...targetPlatforms, ...Object.keys(results)]);
  if (!platforms.length || (platforms.length === 1 && platforms[0] === 'web')) return null;
  return platforms.map((p) => {
    const r = results[p];
    if (!r) return { platform: p, mark: '–', label: `${p} –`, trace: null, title: 'まだ実行していません' };
    const mark = r.status === 'passed' ? '✓' : r.status === 'skipped' ? '–' : '✗';
    const trace = r.trace && r.runId ? { runId: r.runId, testId, platform: p } : null;
    return { platform: p, mark, label: `${p} ${mark}`, trace, title: trace ? `${p} のトレースを開く` : 'トレースはありません' };
  });
}
