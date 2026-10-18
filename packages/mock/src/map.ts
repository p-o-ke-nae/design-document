import { z } from 'zod';
import YAML from 'yaml';
import { PLATFORMS, type Platform } from './platform.ts';

export const SCREEN_MAP_FILE = '_map.yaml';

/** How a screen (state id) is recognised. web: `url` / `selector`; wpf / winforms: exactly one of `automationId` / `title`. */
export interface ScreenRule {
  /** Regular expression matched against the URL path. */
  url?: string;
  selector?: string;
  automationId?: string;
  /** Title of the foreground window. */
  title?: string;
}

/** One platform section of `_map.yaml`. */
export interface PlatformMap {
  screens: Record<string, ScreenRule>;
  /** Event name (guard excluded) → element of the transition click. */
  events: Record<string, string>;
  /** Logical name → element of input / expect / auxiliary click. */
  fields: Record<string, string>;
  /** Logical names excluded from the desktop name check (always empty for web). */
  ignore: string[];
}

/** `scenarios/_map.yaml` normalized into platform sections (the legacy top-level form is the web section). */
export interface ScreenMap {
  readonly web: PlatformMap;
  readonly wpf: PlatformMap;
  readonly winforms: PlatformMap;
  of(platform: Platform): PlatformMap;
}

export const emptyPlatformMap = (): PlatformMap => ({ screens: {}, events: {}, fields: {}, ignore: [] });

/** Builds a `ScreenMap`; missing sections / fields are empty. */
export function createScreenMap(sections: Partial<Record<Platform, Partial<PlatformMap>>> = {}): ScreenMap {
  const sec = (p: Platform): PlatformMap => ({ ...emptyPlatformMap(), ...(sections[p] ?? {}) });
  const web = sec('web');
  const wpf = sec('wpf');
  const winforms = sec('winforms');
  return { web, wpf, winforms, of: (p) => (p === 'web' ? web : p === 'wpf' ? wpf : winforms) };
}

const ScreenRuleSchema = z.strictObject({
  url: z.string().optional(),
  selector: z.string().optional(),
  automationId: z.string().optional(),
  title: z.string().optional(),
});

const SectionSchema = z.strictObject({
  screens: z.record(z.string(), ScreenRuleSchema).default({}),
  events: z.record(z.string(), z.string()).default({}),
  fields: z.record(z.string(), z.string()).default({}),
  ignore: z.array(z.string()).default([]),
});

export interface ScreenMapIssue {
  /** Path in the YAML file (for the line number). */
  path: (string | number)[];
  message: string;
}

export type ScreenMapResult = { ok: true; map: ScreenMap; legacy: boolean } | { ok: false; issues: ScreenMapIssue[]; legacy: boolean };

const LEGACY_KEYS = ['screens', 'events', 'fields'];
const RULE_TEXT: Record<Platform, string> = { web: 'url か selector', wpf: 'automationId か title のどちらか 1 つ', winforms: 'automationId か title のどちらか 1 つ' };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function ruleFits(platform: Platform, r: ScreenRule): boolean {
  if (platform === 'web') return (r.url !== undefined || r.selector !== undefined) && r.automationId === undefined && r.title === undefined;
  return (r.automationId !== undefined) !== (r.title !== undefined) && r.url === undefined && r.selector === undefined;
}

/** Normalizes a parsed `_map.yaml` into platform sections (detailed design: 対応表の読み込み). */
export function normalizeScreenMap(raw: unknown): ScreenMapResult {
  const data = raw ?? {};
  if (!isObject(data)) return { ok: false, legacy: false, issues: [{ path: [], message: '_map.yaml の形式が不正です（キーと値の組で書いてください）' }] };
  const keys = Object.keys(data);
  const legacy = keys.some((k) => LEGACY_KEYS.includes(k));
  const platformKeys = keys.filter((k) => (PLATFORMS as readonly string[]).includes(k));
  if (legacy && platformKeys.length) {
    return { ok: false, legacy, issues: [{ path: [platformKeys[0]], message: '_map.yaml: 従来の形式（直下の screens・events・fields）とプラットフォームの節（web・wpf・winforms）は同時に書けません' }] };
  }
  const allowed = legacy ? LEGACY_KEYS : (PLATFORMS as readonly string[]);
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (unknown.length) return { ok: false, legacy, issues: unknown.map((k) => ({ path: [k], message: `_map.yaml の ${k}: 不明なキーです` })) };

  const issues: ScreenMapIssue[] = [];
  const sections: Partial<Record<Platform, PlatformMap>> = {};
  const inputs: Array<{ platform: Platform; base: string[]; value: unknown }> = legacy ? [{ platform: 'web', base: [], value: data }] : platformKeys.map((k) => ({ platform: k as Platform, base: [k], value: data[k] }));
  for (const { platform, base, value } of inputs) {
    const v = value ?? {};
    if (platform === 'web' && isObject(v) && 'ignore' in v) {
      issues.push({ path: [...base, 'ignore'], message: '_map.yaml の web.ignore: 不明なキーです（ignore は wpf・winforms の節にだけ書けます）' });
      continue;
    }
    const r = SectionSchema.safeParse(v);
    if (!r.success) {
      for (const i of r.error.issues) {
        const p = i.path.map((x) => (typeof x === 'number' ? x : String(x)));
        issues.push({ path: [...base, ...p], message: `_map.yaml の ${[platform, ...p].join('.')}: ${i.message}` });
      }
      continue;
    }
    for (const [id, rule] of Object.entries(r.data.screens)) {
      if (!ruleFits(platform, rule)) issues.push({ path: [...base, 'screens', id], message: `_map.yaml の ${platform}.screens.${id}: ${platform} では ${RULE_TEXT[platform]} で画面を指定してください` });
    }
    sections[platform] = r.data;
  }
  if (issues.length) return { ok: false, legacy, issues };
  return { ok: true, legacy, map: createScreenMap(sections) };
}

export class ScreenMapError extends Error {
  constructor(readonly issues: ScreenMapIssue[]) {
    super(issues.map((i) => i.message).join(' / '));
    this.name = 'ScreenMapError';
  }
}

/** Parses `_map.yaml` text into a `ScreenMap` (throws `ScreenMapError` / the YAML error). */
export function parseScreenMap(text: string): ScreenMap {
  const r = normalizeScreenMap(YAML.parse(text));
  if (!r.ok) throw new ScreenMapError(r.issues);
  return r.map;
}

/** `ScreenMap` from an already-parsed object (throws `ScreenMapError`). */
export function screenMapFrom(raw: unknown): ScreenMap {
  const r = normalizeScreenMap(raw);
  if (!r.ok) throw new ScreenMapError(r.issues);
  return r.map;
}

