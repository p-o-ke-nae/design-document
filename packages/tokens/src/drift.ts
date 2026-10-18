import { parseTokenSets, type DdvConfig, type TokenSetConfig } from '@ddv/core';
import { normalizePath, type TokenFs } from './fs.ts';
import { configHash, sha256Hex, TOKEN_FORMAT } from './schema.ts';
import { parseHeader } from './writer.ts';

/** Same shape as `LintIssue` of `@ddv/core` (rule `tokens` or `tokens-config`). */
export interface TokenIssue {
  severity: 'error' | 'warning';
  rule: 'tokens' | 'tokens-config';
  path: string;
  message: string;
}

export interface TokenCheckResult {
  issues: TokenIssue[];
  /** Shown only by `ddv tokens check` (sources skipped because the set is optional). */
  infos: string[];
}

export interface TokenCheckOptions {
  /** `DDV_TOKENS_OPTIONAL=1`: treat every set as optional. */
  optionalEnv?: boolean;
}

export const DRIFT_MESSAGES = {
  missing: '未生成です（ddv tokens generate を実行してください）',
  noHeader: 'ヘッダがありません（再生成してください）',
  format: '生成の規則が変わりました（再生成してください）',
  config: '設定が変わりました（再生成してください）',
  sourceMissing: (p: string) => `生成元が見つかりません: ${p}`,
  sourceChanged: (p: string) => `生成元が変更されました（再生成してください）: ${p}`,
  skipped: (p: string) => `情報: 生成元が見つからないため検査を省略しました: ${p}`,
} as const;

/** Checks one set against its generated file (`TCHK`). Reads sources only; never converts. */
export async function checkTokenSet(set: TokenSetConfig, fs: TokenFs, opts: TokenCheckOptions = {}): Promise<TokenCheckResult> {
  const issues: TokenIssue[] = [];
  const infos: string[] = [];
  const warn = (message: string) => issues.push({ severity: 'warning', rule: 'tokens', path: set.out, message });
  const text = await fs.read(set.out);
  if (text === null) {
    warn(DRIFT_MESSAGES.missing);
    return { issues, infos };
  }
  const header = parseHeader(text);
  if (!header) {
    warn(DRIFT_MESSAGES.noHeader);
    return { issues, infos };
  }
  if (header.format !== TOKEN_FORMAT) {
    warn(DRIFT_MESSAGES.format);
    return { issues, infos };
  }
  const recorded = new Set(header.sources.map((s) => s.path.toLowerCase()));
  if (header.config !== (await configHash(set)) || !set.sources.every((s) => recorded.has(normalizePath(s).toLowerCase()))) {
    warn(DRIFT_MESSAGES.config);
    return { issues, infos };
  }
  const contents: Array<string | null> = [];
  for (const s of header.sources) contents.push(await fs.read(s.path));
  const unreadable = header.sources.filter((_, i) => contents[i] === null);
  if (unreadable.length) {
    for (const s of unreadable) {
      if (set.optional || opts.optionalEnv) infos.push(DRIFT_MESSAGES.skipped(s.path));
      else warn(DRIFT_MESSAGES.sourceMissing(s.path));
    }
    return { issues, infos };
  }
  for (let i = 0; i < header.sources.length; i++) {
    if ((await sha256Hex(contents[i] as string)) !== header.sources[i].sha256) warn(DRIFT_MESSAGES.sourceChanged(header.sources[i].path));
  }
  return { issues, infos };
}

/** Checks every valid set of the config (config issues included). Browser-safe: reads through `TokenFs`. */
export async function checkTokenSets(config: DdvConfig, fs: TokenFs, opts: TokenCheckOptions = {}): Promise<TokenCheckResult> {
  const { sets, issues: configIssues } = parseTokenSets(config);
  const result: TokenCheckResult = { issues: [...configIssues], infos: [] };
  for (const set of sets) {
    const r = await checkTokenSet(set, fs, opts);
    result.issues.push(...r.issues);
    result.infos.push(...r.infos);
  }
  return result;
}
