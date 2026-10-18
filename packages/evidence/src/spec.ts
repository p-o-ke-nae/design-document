// Evidence specs of scenario steps (detailed design evidence-spec.md#構造・#形式の検査). Browser-safe: no node:* imports.
import { z } from 'zod';

export type Scalar = string | number | boolean;
export interface InputRef {
  input: string;
}
/** One value of `with`: array items are scalars only (no nesting, no input refs). */
export type WithValue = Scalar | Scalar[] | InputRef;
/** `with` of an item. Only `db`'s `params` may hold a one-level map of `WithValue`. */
export type EvidenceWith = Record<string, WithValue | Record<string, WithValue>>;

export const EVIDENCE_AT = ['before', 'after'] as const;
export type EvidenceAt = (typeof EVIDENCE_AT)[number];
export const ON_ERROR = ['fail', 'warn'] as const;
export type OnError = (typeof ON_ERROR)[number];

export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 600_000;

/** An item as written in the scenario (`steps[].evidence[]`). */
export interface EvidenceSpecInput {
  use: string;
  at?: EvidenceAt;
  label?: string;
  with?: EvidenceWith;
  onError?: OnError;
  timeout?: number;
}

/** An item with defaults filled in (`normalizeSpec`). */
export interface EvidenceSpec {
  use: string;
  at: EvidenceAt;
  label: string;
  with: EvidenceWith;
  onError: OnError;
  timeout?: number;
}

/**
 * Shape only (types of the keys). Presence and values (`use` empty, `at`, `onError`, `timeout` range, `with` values,
 * duplicate labels) are checked by `validateEvidence` so that its messages are reported instead of zod's.
 */
export const EvidenceSpecSchema = z.strictObject({
  use: z.string().optional(),
  at: z.string().optional(),
  label: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  onError: z.string().optional(),
  timeout: z.number().optional(),
});

/** `steps[].evidence` of `StepSchema`. */
export const EvidenceListSchema = z.array(EvidenceSpecSchema);

/** Fills defaults: `at` → after, `label` → use, `with` → {}, `onError` → fail. */
export function normalizeSpec(raw: EvidenceSpecInput): EvidenceSpec {
  const out: EvidenceSpec = { use: raw.use, at: raw.at ?? 'after', label: raw.label ?? raw.use, with: raw.with ?? {}, onError: raw.onError ?? 'fail' };
  if (raw.timeout !== undefined) out.timeout = raw.timeout;
  return out;
}

export const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `{ input: <key> }` with no other key. */
export function isInputRef(v: unknown): v is InputRef {
  return isPlainObject(v) && Object.keys(v).length === 1 && typeof v.input === 'string' && v.input.length > 0;
}

/** Scalar, array of scalars, or an input ref. */
export function isWithValue(v: unknown): v is WithValue {
  return isScalar(v) || (Array.isArray(v) && v.every(isScalar)) || isInputRef(v);
}

/** Keys of `with` whose values are not allowed (`db`'s `params` is looked into one level). */
export function invalidWithKeys(use: string, w: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(w)) {
    if (use === 'db' && k === 'params' && isPlainObject(v) && !isInputRef(v)) {
      for (const [pk, pv] of Object.entries(v)) if (!isWithValue(pv)) bad.push(`params.${pk}`);
    } else if (!isWithValue(v)) bad.push(k);
  }
  return bad;
}

/** Issue in the same form as `ScenarioIssue` of `@ddv/mock`. */
export interface EvidenceIssue {
  path: string;
  message: string;
}

interface StepLike {
  evidence?: readonly unknown[];
}

/** Display label of a raw item (label → use → empty). */
export function labelOf(item: unknown): string {
  if (!isPlainObject(item)) return '';
  if (typeof item.label === 'string') return item.label;
  return typeof item.use === 'string' ? item.use : '';
}

/**
 * Semantic checks of every step's `evidence` (SPECVAL). One issue per item at most.
 * Location: 「シナリオ <ID> のステップ <n> の証跡 <m>（<label>）」 (1-based; auxiliary steps counted).
 */
export function validateEvidence(scenario: { id: string; steps: readonly StepLike[] }): EvidenceIssue[] {
  const issues: EvidenceIssue[] = [];
  scenario.steps.forEach((step, i) => {
    if (!Array.isArray(step?.evidence)) return;
    const labels = new Set<string>();
    step.evidence.forEach((item: unknown, j: number) => {
      const path = (...rest: string[]) => ['steps', String(i), 'evidence', String(j), ...rest].join('.');
      const add = (p: string, message: string) =>
        issues.push({ path: p, message: `シナリオ ${scenario.id} のステップ ${i + 1} の証跡 ${j + 1}（${labelOf(item)}）: ${message}` });
      if (!isPlainObject(item) || typeof item.use !== 'string' || !item.use.trim()) return add(path('use'), 'use（取得手段の名前）が必要です');
      if (item.at !== undefined && !(EVIDENCE_AT as readonly unknown[]).includes(item.at)) return add(path('at'), 'at は before か after です');
      if (item.onError !== undefined && !(ON_ERROR as readonly unknown[]).includes(item.onError)) return add(path('onError'), 'onError は fail か warn です');
      const t = item.timeout;
      if (t !== undefined && !(typeof t === 'number' && Number.isInteger(t) && t >= MIN_TIMEOUT_MS && t <= MAX_TIMEOUT_MS)) {
        return add(path('timeout'), `timeout は ${MIN_TIMEOUT_MS}〜${MAX_TIMEOUT_MS} ミリ秒の整数です`);
      }
      if (item.with !== undefined) {
        const bad = isPlainObject(item.with) ? invalidWithKeys(item.use, item.with) : [''];
        if (bad.length) return add(bad[0] ? path('with', ...bad[0].split('.')) : path('with'), `with の値に使えない形があります${bad[0] ? `（${bad.join(', ')}）` : ''}`);
      }
      const label = labelOf(item);
      if (labels.has(label)) return add(path(item.label !== undefined ? 'label' : 'use'), `同じステップに同じ表示名があります: ${label}`);
      labels.add(label);
    });
  });
  return issues;
}
