// One list of providers: built-in, hooks and commands (detailed design evidence-spec.md#取得手段の一覧).
import { existsSync, promises as fs } from 'node:fs';
import { safeJoin } from '@ddv/core/node';
import { parseEvidenceConfig, type DatabaseConfig, type EvidenceConfig, type ParamDef } from './config.ts';
import { DEFAULT_HOOKS_FILE, scanEvidenceHooks, type HooksScan, type ProviderInfo } from './hooks-scan.ts';

export type { ProviderInfo, ProviderKind, HooksScan } from './hooks-scan.ts';

export const BUILTIN_NAMES = ['screenshot', 'db'] as const;
export const PROVIDER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const CONFIG_SOURCE = 'ddv.config.yaml';

const optional = (...names: string[]): Record<string, ParamDef> => Object.fromEntries(names.map((n) => [n, { required: false }]));

/** Built-in providers. `db`'s `sql` / `file` (exactly one) is checked by its own lint rule. */
export const BUILTIN_PROVIDERS: readonly ProviderInfo[] = [
  { name: 'screenshot', kind: 'builtin', params: optional('target', 'fullPage'), paramsKnown: true, source: 'builtin' },
  { name: 'db', kind: 'builtin', params: optional('db', 'sql', 'file', 'params', 'mask', 'maxRows'), paramsKnown: true, source: 'builtin' },
];

export interface RegistryIssue {
  severity: 'error' | 'warning';
  /** File the issue is about (config or hooks file). */
  source: string;
  message: string;
}

export interface EvidenceRegistry {
  /** Built-in → hooks → commands, each in name order. */
  providers: Map<string, ProviderInfo>;
  databases: Map<string, DatabaseConfig>;
  issues: RegistryIssue[];
  hooks: HooksScan;
  config: EvidenceConfig;
  get(name: string): ProviderInfo | undefined;
}

export interface RegistryOptions {
  /** Hooks file relative to the repository root (default `e2e/ddv-hooks.ts`). */
  hooksFile?: string;
  /** Name of the config file for messages (default `ddv.config.yaml`). */
  configSource?: string;
}

const byName = (a: ProviderInfo, b: ProviderInfo) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Merges providers from the hooks scan and the (already validated) config (REGMERGE). Pure; used by `loadRegistry`. */
export function buildRegistry(config: EvidenceConfig, hooks: HooksScan, opts: RegistryOptions = {}): EvidenceRegistry {
  const configSource = opts.configSource ?? CONFIG_SOURCE;
  const issues: RegistryIssue[] = hooks.warnings.map((message) => ({ severity: 'warning', source: opts.hooksFile ?? DEFAULT_HOOKS_FILE, message }));
  const commands: ProviderInfo[] = Object.entries(config.commands).map(([name, c]) => ({
    name,
    kind: 'command',
    params: c.params,
    paramsKnown: true,
    ...(c.timeout !== undefined ? { timeout: c.timeout } : {}),
    source: configSource,
  }));
  const hookNames = new Set(hooks.providers.map((p) => p.name));
  const commandNames = new Set(commands.map((p) => p.name));
  const providers = new Map<string, ProviderInfo>(BUILTIN_PROVIDERS.map((p) => [p.name, p]));
  const reported = new Set<string>();
  const accept = (p: ProviderInfo) => {
    const error = (message: string) => issues.push({ severity: 'error', source: p.source, message });
    if ((BUILTIN_NAMES as readonly string[]).includes(p.name)) return error(`組み込みと同じ名前は登録できません: ${p.name}`);
    if (hookNames.has(p.name) && commandNames.has(p.name)) {
      if (reported.has(p.name)) return;
      reported.add(p.name);
      issues.push({ severity: 'error', source: configSource, message: `hooks と設定の両方に同じ名前があります: ${p.name}` });
      return;
    }
    if (!PROVIDER_NAME.test(p.name)) return error(`取得手段の名前に使えない文字があります（英数字・-・_ で 1〜64 文字）: ${p.name}`);
    providers.set(p.name, p);
  };
  [...hooks.providers].sort(byName).forEach(accept);
  [...commands].sort(byName).forEach(accept);
  return {
    providers,
    databases: new Map(Object.entries(config.databases)),
    issues,
    hooks,
    config,
    get: (name) => providers.get(name),
  };
}

/** Reads the config and the hooks file (without executing it) and builds the registry. */
export async function loadRegistry(repoRoot: string, config: { evidence?: unknown }, opts: RegistryOptions = {}): Promise<EvidenceRegistry> {
  const hooksFile = opts.hooksFile ?? DEFAULT_HOOKS_FILE;
  let hooks: HooksScan = { found: false, readable: false, providers: [], warnings: [] };
  let abs: string | undefined;
  try {
    abs = safeJoin(repoRoot, hooksFile);
  } catch {
    abs = undefined;
  }
  if (abs && existsSync(abs)) hooks = scanEvidenceHooks(await fs.readFile(abs, 'utf8'), hooksFile);
  return buildRegistry(parseEvidenceConfig(config.evidence).config, hooks, { ...opts, hooksFile });
}

/** Names for messages: 「組み込み：screenshot・db、登録：<names>」. */
export function registeredNames(reg: EvidenceRegistry): string {
  const others = [...reg.providers.values()].filter((p) => p.kind !== 'builtin').map((p) => p.name);
  return `組み込み：${BUILTIN_NAMES.join('・')}、登録：${others.length ? others.join('・') : 'なし'}`;
}
