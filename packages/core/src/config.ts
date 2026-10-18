import { z } from 'zod';

export const RunnerSchema = z.object({
  name: z.string(),
  type: z.enum(['vitest', 'playwright', 'dotnet', 'command', 'flaui']),
  /** Working directory relative to the repository root. */
  cwd: z.string().default('.'),
  level: z.enum(['unit', 'integration']).default('unit'),
  /** Globs (relative to cwd) of test sources scanned for test ids. */
  include: z.array(z.string()).optional(),
  /** For `command` runners: command line with `{pattern}`, `{ids}` and `{junit}` placeholders. */
  command: z.string().optional(),
  /** Playwright runners: also link scenario YAML files under mocksRoot by their `id`. */
  scenarios: z.boolean().default(false),
  /** Platform of the results (playwright: web; flaui: wpf / winforms). flaui-driver.md「設定」 */
  platform: z.enum(['web', 'wpf', 'winforms']).optional(),
  /** flaui: the application to start (path relative to the repository root). */
  app: z.object({ path: z.string(), args: z.array(z.string()).default([]), cwd: z.string().optional() }).optional(),
  /** flaui: where the screen definitions are. */
  source: z.string().optional(),
  /** flaui: wait limit in milliseconds. */
  timeout: z.number().int().min(100).optional(),
  automation: z.enum(['uia3', 'uia2']).optional(),
});

export const ConfigSchema = z.object({
  docsRoot: z.string().default('docs'),
  mocksRoot: z.string().default('docs/mocks'),
  /** Optional external documentation repository (Phase 3). */
  source: z.object({ repo: z.string(), branch: z.string().default('main') }).optional(),
  idPrefix: z
    .object({
      requirements: z.string().default('REQ'),
      basic: z.string().default('BD'),
      detailed: z.string().default('DD'),
    })
    .prefault({}),
  toc: z.object({ minLevel: z.number().int().min(1).max(6).default(2), maxLevel: z.number().int().min(1).max(6).default(3) }).prefault({}),
  matrix: z
    .object({
      nSwitch: z.number().int().min(0).default(1),
      loopLimit: z.number().int().min(0).default(1),
      maxPaths: z.number().int().min(1).default(200),
    })
    .prefault({}),
  styles: z.array(z.string()).default([]),
  /** Token sets (design tokens generated from the real app). Each item is validated separately by `parseTokenSets`. */
  tokens: z.array(z.unknown()).default([]),
  runners: z.array(RunnerSchema).default([]),
  mock: z
    .object({
      browser: z.object({ channel: z.string().default('chromium') }).prefault({}),
      snapshot: z
        .object({
          threshold: z.number().min(0).max(1).default(0.001),
          viewport: z.object({ width: z.number().int().min(1).default(1280), height: z.number().int().min(1).default(800) }).prefault({}),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Retention of test run records and traces (0 = unlimited). */
  history: z
    .object({
      maxRuns: z.number().int().min(0).default(200),
      maxTraceRuns: z.number().int().min(0).default(20),
    })
    .prefault({}),
  /** Pages 版の配信元。あるときローカル版に「この画面の Pages 版の URL をコピー」を出す。 */
  pages: z
    .object({
      url: z.url({ protocol: /^https$/, error: 'pages.url は https:// で始まる URL を書いてください' }).transform((u) => u.replace(/\/+$/, '')),
    })
    .optional(),
});

export type DdvConfig = z.infer<typeof ConfigSchema>;
export type RunnerConfig = z.infer<typeof RunnerSchema>;

const TOKEN_SET_NAME = /^[a-z0-9][a-z0-9-]*$/;
const TokenSetCommon = {
  name: z.string().regex(TOKEN_SET_NAME, { error: (iss) => `tokens の name は小文字の英数字とハイフンで書いてください: ${String(iss.input)}` }),
  sources: z.array(z.string().min(1)).min(1, { error: 'tokens の sources に 1 件以上のファイルを書いてください' }),
  overrides: z
    .record(z.string().regex(/^--/, { error: (iss) => `tokens の overrides のキーは -- で始めてください: ${String(iss.input)}` }), z.string())
    .default({}),
  out: z.string().optional(),
  optional: z.boolean().default(false),
};

/** One item of `tokens` (discriminated by `kind`). */
export const TokenSetSchema = z.discriminatedUnion('kind', [
  z.object({
    ...TokenSetCommon,
    kind: z.literal('xaml'),
    prefix: z.string().regex(/^[a-z][a-z0-9-]*$/, { error: (iss) => `tokens の prefix は小文字で始まる英数字とハイフンで書いてください: ${String(iss.input)}` }).optional(),
    fontSizeKeys: z.array(z.string()).default([]),
  }),
  z.object({
    ...TokenSetCommon,
    kind: z.literal('css'),
    classes: z.array(z.string().regex(/^[^.]/, { error: (iss) => `tokens の classes には先頭の . を付けないでください: ${String(iss.input)}` })).default([]),
    elements: z.array(z.string()).default([]),
  }),
]);

/** A validated token set with every field filled in (`out` resolved against mocksRoot). */
export interface TokenSetConfig {
  name: string;
  kind: 'xaml' | 'css';
  sources: string[];
  prefix?: string;
  fontSizeKeys: string[];
  classes: string[];
  elements: string[];
  overrides: Record<string, string>;
  out: string;
  optional: boolean;
}

export interface TokenConfigIssue {
  severity: 'error' | 'warning';
  rule: 'tokens-config';
  path: string;
  message: string;
}

const KIND_ONLY: Record<'xaml' | 'css', string[]> = { xaml: ['prefix', 'fontSizeKeys'], css: ['classes', 'elements'] };

function normalizeRel(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Validates `config.tokens` item by item; invalid items are reported and left out. */
export function parseTokenSets(config: DdvConfig, configPath = 'ddv.config.yaml'): { sets: TokenSetConfig[]; issues: TokenConfigIssue[] } {
  const sets: TokenSetConfig[] = [];
  const issues: TokenConfigIssue[] = [];
  const add = (severity: 'error' | 'warning', message: string) => issues.push({ severity, rule: 'tokens-config', path: configPath, message });
  const mocksRoot = normalizeRel(config.mocksRoot);
  const seen = new Set<string>();
  for (const raw of config.tokens) {
    if (typeof raw === 'string') {
      add('warning', `tokens の文字列の項目は使われなくなりました（無視します）: ${raw}`);
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      add('error', `tokens の項目はオブジェクトで書いてください: ${JSON.stringify(raw)}`);
      continue;
    }
    const obj = raw as Record<string, unknown>;
    if (obj.kind !== 'xaml' && obj.kind !== 'css') {
      add('error', `tokens の kind は xaml か css です: ${obj.kind === undefined ? '（なし）' : String(obj.kind)}`);
      continue;
    }
    const r = TokenSetSchema.safeParse(obj);
    if (!r.success) {
      const label = typeof obj.name === 'string' ? obj.name : '?';
      for (const iss of r.error.issues) add('error', iss.message.startsWith('tokens の') ? iss.message : `tokens（${label}）の ${iss.path.join('.')}: ${iss.message}`);
      continue;
    }
    const v = r.data;
    const other = v.kind === 'xaml' ? 'css' : 'xaml';
    for (const key of KIND_ONLY[other]) if (key in obj) add('warning', `kind: ${v.kind} では ${key} は使いません`);
    if (seen.has(v.name)) {
      add('error', `tokens の name が重複しています: ${v.name}`);
      continue;
    }
    seen.add(v.name);
    let out = `${mocksRoot}/_tokens/${v.name}.css`;
    if (v.out !== undefined) {
      const n = normalizeRel(v.out);
      if (!n.endsWith('.css') || !n.startsWith(`${mocksRoot}/`) || n.split('/').includes('..') || /^[a-zA-Z]:|^\//.test(v.out)) {
        add('error', `tokens の out は mocksRoot（${config.mocksRoot}）の下の .css にしてください: ${v.out}`);
        continue;
      }
      out = n;
    }
    sets.push({
      name: v.name,
      kind: v.kind,
      sources: v.sources,
      prefix: v.kind === 'xaml' ? v.prefix : undefined,
      fontSizeKeys: v.kind === 'xaml' ? v.fontSizeKeys : [],
      classes: v.kind === 'css' ? v.classes : [],
      elements: v.kind === 'css' ? v.elements : [],
      overrides: v.overrides,
      out,
      optional: v.optional,
    });
  }
  return { sets, issues };
}

export function parseConfig(raw: unknown): DdvConfig {
  return ConfigSchema.parse(raw ?? {});
}

export type DocKind = 'requirements' | 'basic' | 'detailed' | 'other';

export function inferDocKind(path: string, frontKind?: unknown): DocKind {
  if (frontKind === 'requirements' || frontKind === 'basic' || frontKind === 'detailed') return frontKind;
  const p = path.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(requirements?|req|要件定義)(\/|$)/.test(p)) return 'requirements';
  if (/(^|\/)(basic|基本設計)(\/|$)/.test(p)) return 'basic';
  if (/(^|\/)(detailed|detail|詳細設計)(\/|$)/.test(p)) return 'detailed';
  return 'other';
}
