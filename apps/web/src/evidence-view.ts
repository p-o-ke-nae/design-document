import type { EvidenceFile, OmittedReason, TraceEvidence } from '@ddv/mock/trace-format';
import { parseTable, toCsv } from './evidence-csv.ts';

export type { EvidenceFile, TraceEvidence };

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export const AT_LABEL: Record<TraceEvidence['at'], string> = { before: '操作前', after: '判定後' };
export const STATUS_LABEL: Record<TraceEvidence['status'], string> = { ok: '取得', warn: '警告', failed: '失敗', skipped: '対象外' };
export const OMITTED_MESSAGE: Record<OmittedReason, string> = { 'too-large': '大きすぎるため保存していません', 'branch-limit': '結果ブランチに置いていません' };
const OMITTED_REASON: Record<OmittedReason, string> = { 'too-large': '大きすぎる', 'branch-limit': '結果ブランチに置いていない' };
export const SKIPPED_NOTE = '対象外（only の指定）';
export const LIVE_NOTE = 'プレイヤーの再生では証跡を取得しません（E2E の実行で取得します）';

/** 「取得手段」 of the list (evidence-trace.md「画面」). */
export function useLabel(r: Pick<TraceEvidence, 'use' | 'provider' | 'db'>): string {
  if (r.db) return `${r.use}（${r.db.name}・${r.db.type}）`;
  if (r.provider === 'command') return `${r.use}（コマンド）`;
  if (r.provider === 'hooks') return `${r.use}（hooks）`;
  return r.use;
}

/** 「種類」 of the list (evidence-trace.md「種類の表示」); the first file decides. */
export function kindLabel(r: Pick<TraceEvidence, 'files' | 'totalRows'>): string {
  const f = r.files[0];
  if (!f) return '—';
  if (f.kind === 'image') return '画像';
  if (f.kind === 'table') return r.totalRows !== undefined ? `表（${r.totalRows} 行）` : '表';
  if (f.kind === 'json') return 'JSON';
  if (f.kind === 'text') return 'テキスト';
  const ext = /\.([^./]+)$/.exec(f.path)?.[1];
  return ext ? `ファイル（${ext}）` : 'ファイル';
}

/** Text after the title: 時点・取得手段・所要時間. */
export const titleDetail = (r: TraceEvidence) => `${AT_LABEL[r.at]}・${useLabel(r)}・${secs(r.durationMs)}`;

/** 「証跡 n」 of a timeline row (non-`skipped` records) and whether to show ⚠. */
export function stepMarks(evidence: TraceEvidence[] | undefined): { count: number; warn: boolean } | null {
  const count = (evidence ?? []).filter((e) => e.status !== 'skipped').length;
  if (!count) return null;
  return { count, warn: (evidence ?? []).some((e) => e.status === 'warn' || e.status === 'failed') };
}

export type RowAction =
  | { kind: 'none'; note: string }
  | { kind: 'expand'; text: string }
  | { kind: 'dialog' };

/** What the row's 開く・保存 do (DD-EVTRACE-EVROW). `save` only with `dialog`. */
export function rowAction(r: TraceEvidence): RowAction {
  if (r.status === 'skipped') return { kind: 'none', note: SKIPPED_NOTE };
  if (r.status !== 'ok') return { kind: 'expand', text: `取得に失敗しました：${r.reason ?? '（理由なし）'}` };
  if (!r.files.length || r.files.every((f) => f.omitted)) {
    const reasons = [...new Set(r.files.map((f) => OMITTED_MESSAGE[f.omitted ?? 'too-large']))];
    return { kind: 'expand', text: reasons.join('・') || '保存したファイルはありません' };
  }
  return { kind: 'dialog' };
}

/** The expanded row after pressing 開く on `seq` (one at a time; again closes). */
export const toggleExpanded = (current: number | null, seq: number): number | null => (current === seq ? null : seq);

/** Records the dialog cycles through: `ok` with a non-omitted file, in `seq` order. */
export const navigable = (records: TraceEvidence[]) => records.filter((r) => r.status === 'ok' && r.files.some((f) => !f.omitted)).sort((a, b) => a.seq - b.seq);

/** Next / previous navigable record (wraps around). */
export function stepTarget(records: TraceEvidence[], seq: number, dir: 1 | -1): number | null {
  const list = navigable(records);
  if (!list.length) return null;
  const i = list.findIndex((r) => r.seq === seq);
  if (i < 0) return list[0].seq;
  return list[(i + dir + list.length) % list.length].seq;
}

/** First non-omitted file of a record. */
export const firstFile = (r: TraceEvidence) => Math.max(0, r.files.findIndex((f) => !f.omitted));

export interface DialogTarget {
  seq: number;
  file: number;
}

export type DialogState =
  | { phase: 'closed'; token: number }
  | { phase: 'loading'; target: DialogTarget; token: number }
  | { phase: 'shown'; target: DialogTarget; token: number; blob: Blob }
  | { phase: 'failed'; target: DialogTarget; token: number; error: string };

export type DialogEvent =
  | { type: 'open'; target: DialogTarget }
  | { type: 'loaded'; token: number; blob: Blob }
  | { type: 'failed'; token: number; error: string }
  /** 次の証跡・前の証跡・ファイルの切り替え while shown. */
  | { type: 'switch'; target: DialogTarget }
  /** 次の証跡・前の証跡 after a failure. */
  | { type: 'step'; target: DialogTarget }
  | { type: 'save' }
  | { type: 'close' };

export const DIALOG_CLOSED: DialogState = { phase: 'closed', token: 0 };

/** Dialog states (DD-EVTRACE-EVDLG). Events that do not apply leave the state as is; stale results (other token) are dropped. */
export function reduceDialog(s: DialogState, e: DialogEvent): DialogState {
  const load = (target: DialogTarget): DialogState => ({ phase: 'loading', target, token: s.token + 1 });
  switch (e.type) {
    case 'open':
      return s.phase === 'closed' ? load(e.target) : s;
    case 'loaded':
      return s.phase === 'loading' && e.token === s.token ? { phase: 'shown', target: s.target, token: s.token, blob: e.blob } : s;
    case 'failed':
      return s.phase === 'loading' && e.token === s.token ? { phase: 'failed', target: s.target, token: s.token, error: e.error } : s;
    case 'switch':
      return s.phase === 'shown' ? load(e.target) : s;
    case 'step':
      return s.phase === 'failed' ? load(e.target) : s;
    case 'save':
      return s;
    case 'close':
      return s.phase === 'closed' ? s : { phase: 'closed', token: s.token + 1 };
  }
}

/** Whether 保存 can be pressed in the dialog. */
export const canSave = (s: DialogState) => s.phase === 'shown';

/** Event of 次の証跡 / 前の証跡 in the current state (null = ignored). */
export function moveEvent(s: DialogState, records: TraceEvidence[], dir: 1 | -1): DialogEvent | null {
  if (s.phase !== 'shown' && s.phase !== 'failed') return null;
  const seq = stepTarget(records, s.target.seq, dir);
  const r = records.find((x) => x.seq === seq);
  if (seq === null || !r) return null;
  const target = { seq, file: firstFile(r) };
  return s.phase === 'shown' ? { type: 'switch', target } : { type: 'step', target };
}

/** `evidence-note` (evidence-trace.md「注記」). `writtenRows` = rows of the loaded table. */
export function evidenceNote(r: TraceEvidence, opts: { file?: EvidenceFile; writtenRows?: number } = {}): string | null {
  const parts: string[] = [];
  if (r.masked?.length) parts.push(`${r.masked.join(',')} は伏せています`);
  const kind = (opts.file ?? r.files[0])?.kind;
  if (kind === 'table' && opts.writtenRows !== undefined) {
    const n = opts.writtenRows;
    const total = r.totalRows ?? n;
    parts.push(!r.truncated && total === n + 1 && n > 0 ? `${n} 行以上のうち ${n} 行を表示` : `${total} 行中 ${n} 行を表示`);
  }
  if (r.truncated && kind !== 'table') parts.push('上限の大きさで切っています');
  const omitted = r.files.filter((f) => f.omitted);
  if (omitted.length) parts.push(`${omitted.length} 個のファイルは ${OMITTED_REASON[omitted[0].omitted!]} ため表示できません`);
  return parts.length ? `${parts.join('。')}。` : null;
}

/** Last segment of a file path. */
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Name to save as (DD-EVTRACE-EVSAVE): tables become `.csv`. */
export const saveName = (f: Pick<EvidenceFile, 'path' | 'kind'>) => (f.kind === 'table' ? baseName(f.path).replace(/\.table\.json$/, '') + '.csv' : baseName(f.path));

/** Blob to save: tables through `toCsv`, others as fetched. */
export async function saveBlob(f: Pick<EvidenceFile, 'kind'>, blob: Blob): Promise<Blob> {
  if (f.kind !== 'table') return blob;
  const t = parseTable(await blob.text());
  return t ? new Blob([toCsv(t)], { type: 'text/csv;charset=utf-8' }) : blob;
}

export interface DownloadDeps {
  createUrl(b: Blob): string;
  revokeUrl(u: string): void;
  click(href: string, name: string): void;
}

const browserDownload = (): DownloadDeps => ({
  createUrl: (b) => URL.createObjectURL(b),
  revokeUrl: (u) => URL.revokeObjectURL(u),
  click: (href, name) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
});

/** Saves through an `<a download>`; the `blob:` URL is revoked afterwards. */
export async function saveEvidence(f: Pick<EvidenceFile, 'path' | 'kind'>, blob: Blob, deps: DownloadDeps = browserDownload()): Promise<string> {
  const name = saveName(f);
  const url = deps.createUrl(await saveBlob(f, blob));
  try {
    deps.click(url, name);
  } finally {
    setTimeout(() => deps.revokeUrl(url), 0);
  }
  return name;
}

export interface EvidenceCounts {
  evidence?: number;
  evidenceWarnings?: number;
}

export interface EvidenceBadge {
  text: string;
  warn: boolean;
  title?: string;
}

/** `evidence-count` of a matrix row (DD-EVTRACE-EVBADGE). With several platforms, the sum and the breakdown in `title`. */
export function evidenceBadge(byPlatform: Partial<Record<string, EvidenceCounts | undefined>>): EvidenceBadge | null {
  const entries = Object.entries(byPlatform).filter((e): e is [string, EvidenceCounts] => !!e[1]);
  const n = entries.reduce((a, [, r]) => a + (r.evidence ?? 0), 0);
  if (n < 1) return null;
  const m = entries.reduce((a, [, r]) => a + (r.evidenceWarnings ?? 0), 0);
  const badge: EvidenceBadge = m >= 1 ? { text: `証跡 ${n}・警告 ${m}`, warn: true } : { text: `証跡 ${n}`, warn: false };
  if (entries.length > 1)
    badge.title = entries
      .filter(([, r]) => (r.evidence ?? 0) > 0)
      .map(([p, r]) => `${p}：証跡 ${r.evidence}${r.evidenceWarnings ? `・警告 ${r.evidenceWarnings}` : ''}`)
      .join('\n');
  return badge;
}
