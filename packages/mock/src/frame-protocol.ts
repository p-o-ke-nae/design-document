// postMessage protocol between the viewer and the mock runtime (DD-MOCKSB プロトコル). Shared by both sides; no Node imports.
import type { ExpectFailure, Step } from './step.ts';
import type { LiveStepTrace } from './trace-format.ts';
import type { ElementPatch, PickedElement } from './tune-patch.ts';

/** Version 1 = Phase 5 (no ddv:hello / ddv:init); version 2 adds them and `ddv:ready.protocol`. */
export const FRAME_PROTOCOL = 2;
/** Total size (characters) of the `ddv:init` files. */
export const INIT_FILES_MAX = 10 * 1024 * 1024;
/** `ddv:screen` / `ddv:error` / `ddv:result.message` are cut at this length. */
export const FRAME_TEXT_MAX = 4000;

/** Fixture name → table → rows. */
export type FixtureData = Record<string, Record<string, Array<Record<string, unknown>>>>;

/** Viewer → iframe. */
export type ToFrame =
  | { type: 'ddv:init'; protocol: number; files: Record<string, string> }
  /** `data`: fixture contents by name, used instead of reading `fixtures/<name>.yaml` (playing the editor's draft, DD-TDEDIT). */
  | { type: 'ddv:reset'; fixtures: string[]; start?: string; data?: FixtureData }
  | { type: 'ddv:step'; index: number; step: Step; highlight: { holdMs: number } | null; trace: boolean }
  | { type: 'ddv:tune'; on: boolean }
  | { type: 'ddv:patch'; path: number[]; patch: ElementPatch | null };

/** iframe → viewer. */
export type FromFrame =
  | { type: 'ddv:hello'; protocol: number; version: string }
  | { type: 'ddv:ready'; screen: string | null; version: string; protocol?: number }
  | { type: 'ddv:result'; index: number; ok: boolean; screen: string | null; failures: ExpectFailure[]; message?: string; trace?: LiveStepTrace }
  | { type: 'ddv:screen'; screen: string }
  | { type: 'ddv:error'; message: string }
  | ({ type: 'ddv:picked' } & PickedElement);

export type FrameParser<T> = ((data: unknown) => T | null) & { readonly types: ReadonlySet<string> };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const cut = (s: string) => (s.length > FRAME_TEXT_MAX ? s.slice(0, FRAME_TEXT_MAX) : s);

/** Accepts { holdMs } with a finite, non-negative holdMs (capped at 10s); anything else = no highlight. */
export function validHighlight(h: unknown): { holdMs: number } | null {
  if (!h || typeof h !== 'object') return null;
  const ms = (h as { holdMs?: unknown }).holdMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? { holdMs: Math.min(ms, 10_000) } : null;
}

/** `ddv:reset` data: only plain objects of tables (arrays of row objects) are kept. */
export function validData(d: unknown): FixtureData | undefined {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
  const out: FixtureData = {};
  for (const [name, tables] of Object.entries(d)) {
    if (!tables || typeof tables !== 'object' || Array.isArray(tables)) continue;
    const t: FixtureData[string] = {};
    for (const [table, rows] of Object.entries(tables)) if (Array.isArray(rows)) t[table] = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
    out[name] = t;
  }
  return out;
}

/** `ddv:init` files: string values, ≤ INIT_FILES_MAX in total, keys relative without `..`. */
export function validFiles(f: unknown): Record<string, string> | null {
  if (!isObject(f)) return null;
  const out: Record<string, string> = {};
  let total = 0;
  for (const [k, v] of Object.entries(f)) {
    if (typeof v !== 'string') return null;
    if (!k || k.startsWith('/') || k.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(k) || k.split('/').some((s) => s === '..')) return null;
    total += v.length;
    if (total > INIT_FILES_MAX) return null;
    out[k] = v;
  }
  return out;
}

function parser<T>(types: string[], fn: (type: string, d: Record<string, unknown>) => T | null): FrameParser<T> {
  const set = new Set(types);
  const parse = (data: unknown): T | null => {
    if (!isObject(data) || typeof data.type !== 'string' || !set.has(data.type)) return null;
    return fn(data.type, data);
  };
  return Object.assign(parse, { types: set as ReadonlySet<string> });
}

/** Messages the runtime accepts (viewer → iframe). */
export const parseToFrame: FrameParser<ToFrame> = parser(['ddv:init', 'ddv:reset', 'ddv:step', 'ddv:tune', 'ddv:patch'], (type, d) => {
  switch (type) {
    case 'ddv:init': {
      const files = validFiles(d.files);
      return Number.isInteger(d.protocol) && files ? { type, protocol: d.protocol as number, files } : null;
    }
    case 'ddv:reset': {
      const data = validData(d.data);
      return {
        type,
        fixtures: Array.isArray(d.fixtures) ? (d.fixtures.filter((f) => typeof f === 'string') as string[]) : [],
        ...(typeof d.start === 'string' ? { start: d.start } : {}),
        ...(data ? { data } : {}),
      };
    }
    case 'ddv:step':
      return typeof d.index === 'number' && isObject(d.step) ? { type, index: d.index, step: d.step as unknown as Step, highlight: validHighlight(d.highlight), trace: d.trace === true } : null;
    case 'ddv:tune':
      return typeof d.on === 'boolean' ? { type, on: d.on } : null;
    case 'ddv:patch':
      return Array.isArray(d.path) && d.path.every(isIndex) ? { type, path: d.path as number[], patch: isObject(d.patch) ? (d.patch as unknown as ElementPatch) : null } : null;
  }
  return null;
});

/** Messages the viewer accepts (iframe → viewer). */
export const parseFromFrame: FrameParser<FromFrame> = parser(['ddv:hello', 'ddv:ready', 'ddv:result', 'ddv:screen', 'ddv:error', 'ddv:picked'], (type, d) => {
  switch (type) {
    case 'ddv:hello':
      return Number.isInteger(d.protocol) && typeof d.version === 'string' ? { type, protocol: d.protocol as number, version: d.version } : null;
    case 'ddv:ready':
      if (!(typeof d.screen === 'string' || d.screen === null) || typeof d.version !== 'string') return null;
      return { type, screen: d.screen, version: d.version, ...(Number.isInteger(d.protocol) ? { protocol: d.protocol as number } : {}) };
    case 'ddv:result': {
      if (!isIndex(d.index) || typeof d.ok !== 'boolean' || !Array.isArray(d.failures)) return null;
      return {
        type,
        index: d.index,
        ok: d.ok,
        screen: typeof d.screen === 'string' ? d.screen : null,
        failures: d.failures as ExpectFailure[],
        ...(typeof d.message === 'string' ? { message: cut(d.message) } : {}),
        ...(isObject(d.trace) ? { trace: d.trace as unknown as LiveStepTrace } : {}),
      };
    }
    case 'ddv:screen':
      return typeof d.screen === 'string' ? { type, screen: cut(d.screen) } : null;
    case 'ddv:error':
      return typeof d.message === 'string' ? { type, message: cut(d.message) } : null;
    case 'ddv:picked':
      return Array.isArray(d.path) && d.path.every(isIndex) && typeof d.tag === 'string' ? ({ ...d, type } as unknown as FromFrame) : null;
  }
  return null;
});

export interface FrameExpect {
  /** The window the message must come from (the iframe's contentWindow / the parent). */
  source: unknown;
  /** `'null'` for an opaque-origin (sandboxed srcdoc) sender. */
  origin: string;
}

/** Checks source, origin, shape, known type and payload (DD-MOCKSB RECV). Unknown / malformed messages → null. */
export function acceptFrameMessage<T>(e: Pick<MessageEvent, 'source' | 'origin' | 'data'>, expect: FrameExpect, parse: FrameParser<T>, warn: (msg: string) => void = (m) => console.warn(m)): T | null {
  if (!expect.source || e.source !== expect.source) return null;
  if (e.origin !== expect.origin) return null;
  const d = e.data as unknown;
  if (!isObject(d) || typeof d.type !== 'string' || !d.type.startsWith('ddv:')) return null;
  if (!parse.types.has(d.type)) return null;
  const m = parse(d);
  if (m === null) warn(`[ddv] 形式の違うメッセージを無視しました: ${d.type}`);
  return m;
}
