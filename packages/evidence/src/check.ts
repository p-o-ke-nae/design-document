// ddv-lint extension for evidence specs (detailed design evidence-spec.md#検査lint). Rule `evidence`.
import { existsSync, promises as fs } from 'node:fs';
import type { DdvConfig } from '@ddv/core';
import { CONFIG_FILES, safeJoin, type DocEntry, type LintIssue } from '@ddv/core/node';
import { findScenarioFiles, lineAt, parseScenarioFile, planSteps, type Platform, type Scenario } from '@ddv/mock';
import { MOCK_DB, parseEvidenceConfig, type EvidenceConfig } from './config.ts';
import { HOOKS_UNREADABLE } from './hooks-scan.ts';
import { BUILTIN_NAMES, loadRegistry, registeredNames, type EvidenceRegistry } from './registry.ts';
import { normalizeSpec, type EvidenceSpec, type EvidenceSpecInput } from './spec.ts';
import { checkSql, sqlParams } from './sql-guard.ts';
import { InputScope, resolveWith } from './with.ts';

export const EVIDENCE_RULE = 'evidence';

/** Platforms to check: `web` and the `platform` of each `type: flaui` runner. */
export function lintPlatforms(config: Pick<DdvConfig, 'runners'>): Platform[] {
  const out: Platform[] = ['web'];
  for (const r of config.runners as ReadonlyArray<{ type: string; platform?: unknown }>) {
    if (r.type === 'flaui' && (r.platform === 'wpf' || r.platform === 'winforms') && !out.includes(r.platform)) out.push(r.platform);
  }
  return out;
}

function configFileOf(repoRoot: string): string {
  return CONFIG_FILES.find((n) => existsSync(safeJoin(repoRoot, n))) ?? CONFIG_FILES[0];
}

const hasEvidence = (s: Scenario) => s.steps.some((st) => (st.evidence?.length ?? 0) > 0);

interface SpecContext {
  repoRoot: string;
  registry: EvidenceRegistry;
  config: EvidenceConfig;
  platform: Platform;
  spec: EvidenceSpec;
  scope: ReadonlyMap<string, string | number | boolean>;
  sqlCache: Map<string, string | null>;
}

type Found = { severity: 'error' | 'warning'; message: string };

async function readSqlFile(repoRoot: string, file: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(file)) return cache.get(file)!;
  let text: string | null = null;
  try {
    const abs = safeJoin(repoRoot, file);
    if (existsSync(abs)) text = (await fs.readFile(abs, 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    text = null;
  }
  cache.set(file, text);
  return text;
}

/** The rules of 指定の検査 for one spec on one platform (messages without the location prefix). */
async function checkSpec(c: SpecContext): Promise<Found[]> {
  const { spec, registry } = c;
  const out: Found[] = [];
  const error = (message: string) => out.push({ severity: 'error', message });
  const warn = (message: string) => out.push({ severity: 'warning', message });
  const info = registry.get(spec.use);
  if (!info) {
    const hooksUnreadable = registry.hooks.found && !registry.hooks.readable;
    if (hooksUnreadable && !(BUILTIN_NAMES as readonly string[]).includes(spec.use)) warn(`hooks を読めないため ${spec.use} の登録を確かめられません`);
    else error(`取得手段 ${spec.use} は登録されていません（${registeredNames(registry)}）`);
    return out;
  }
  if (info.paramsKnown) {
    for (const [name, def] of Object.entries(info.params)) {
      if (def.required && def.default === undefined && !(name in spec.with)) error(`必須の引数 ${name} がありません`);
    }
    for (const name of Object.keys(spec.with)) if (!(name in info.params)) warn(`引数 ${name} は ${spec.use} にありません`);
  }
  const r = resolveWith(spec.with, c.scope);
  if (!r.ok) for (const key of r.missing) error(`入力 ${key} はこの時点（${spec.at}）ではありません（${c.platform}）`);
  if (spec.use !== 'db') return out;

  // 接続先: lint checks E1 (desktop without with.db / defaultDatabase) and E3 of evidence-runner.md#db.
  const withDb = r.ok ? r.args.db : spec.with.db;
  const target = withDb !== undefined ? withDb : c.platform === 'web' ? undefined : c.config.defaultDatabase;
  if (withDb === undefined && target === undefined && c.platform !== 'web') {
    error('接続先が決まりません（with.db か evidence.defaultDatabase を書いてください）');
  } else if (target !== undefined && target !== MOCK_DB && !(typeof target === 'string' && registry.databases.has(target))) {
    error(`接続先 ${String(target)} は定義されていません（ddv.config.yaml の evidence.databases）`);
  }

  const sql = spec.with.sql;
  const file = spec.with.file;
  if ((sql === undefined) === (file === undefined)) {
    error('sql と file はどちらか一方を書きます');
    return out;
  }
  let text: string | null;
  if (file !== undefined) {
    text = typeof file === 'string' ? await readSqlFile(c.repoRoot, file, c.sqlCache) : null;
    if (text === null) {
      error(`SQL ファイル ${typeof file === 'string' ? file : JSON.stringify(file)} がありません`);
      return out;
    }
  } else {
    if (typeof sql !== 'string') {
      error('sql は文字列で書きます');
      return out;
    }
    text = sql;
  }
  const g = checkSql(text);
  if (!g.ok) {
    error(g.reason);
    return out;
  }
  const used = sqlParams(text);
  const given = spec.with.params && typeof spec.with.params === 'object' && !Array.isArray(spec.with.params) ? Object.keys(spec.with.params) : [];
  for (const p of used) if (!given.includes(p)) error(`パラメータ ${p} がありません`);
  for (const p of given) if (!used.includes(p)) warn(`パラメータ ${p} は SQL で使っていません`);
  return out;
}

/**
 * `ExtraLintCheck` for evidence (rule `evidence`): the config, the provider registry and each step's `evidence:` of
 * scenarios that passed `validateScenario` (format errors are reported by the scenario check). Nothing is reported for
 * a repository without `evidence` in the config, hooks or scenarios (REQ-810).
 */
export async function checkEvidence(repoRoot: string, config: DdvConfig, _docs?: DocEntry[]): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const configFile = configFileOf(repoRoot);
  const parsed = parseEvidenceConfig(config.evidence);
  for (const message of parsed.errors) issues.push({ severity: 'error', rule: EVIDENCE_RULE, path: configFile, message });
  const registry = await loadRegistry(repoRoot, config, { configSource: configFile });
  for (const i of registry.issues) issues.push({ severity: i.severity, rule: EVIDENCE_RULE, path: i.source, message: i.message });

  const platforms = lintPlatforms(config);
  const sqlCache = new Map<string, string | null>();
  for (const entry of findScenarioFiles(repoRoot, config)) {
    let text: string;
    try {
      text = await fs.readFile(safeJoin(repoRoot, entry.file), 'utf8');
    } catch {
      continue;
    }
    const scenario = parseScenarioFile(text, entry.file).scenario;
    if (!scenario || !hasEvidence(scenario)) continue;
    const seen = new Set<string>();
    for (const platform of platforms) {
      const plan = planSteps(scenario, platform);
      const scope = InputScope.of(scenario, plan);
      for (const p of plan) {
        if (!p.run) continue;
        const list = (p.step.evidence ?? []) as EvidenceSpecInput[];
        for (const [n, raw] of list.entries()) {
          const spec = normalizeSpec(raw);
          const found = await checkSpec({ repoRoot, registry, config: parsed.config, platform, spec, scope: scope.at(spec.at, p.index), sqlCache });
          for (const f of found) {
            const message = `シナリオ ${scenario.id} ステップ ${p.index + 1} の証跡 ${spec.label}: ${f.message}`;
            const key = `${f.severity}\u0000${message}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const line = lineAt(text, ['steps', p.index, 'evidence', n]);
            issues.push({ severity: f.severity, rule: EVIDENCE_RULE, path: entry.file, ...(line ? { line } : {}), message });
          }
        }
      }
    }
  }
  return issues;
}
