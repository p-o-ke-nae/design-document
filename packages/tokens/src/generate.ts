import { parseTokenSets, type DdvConfig, type TokenSetConfig } from '@ddv/core';
import { CssReader } from './css/reader.ts';
import { dirname, joinPath, type TokenFs } from './fs.ts';
import { configHash, type ReadResult, type TokenWarning } from './schema.ts';
import { TokenWriter } from './writer.ts';
import { XamlReader } from './xaml/reader.ts';

export const WPF_BASE_FILE = 'wpf-base.css';

export interface GenerateOptions {
  /** `--name`: generate this set only. */
  name?: string;
  /** Content of the bundled `assets/wpf-base.css` (copied next to the out of xaml sets). */
  wpfBaseCss?: string;
}

export interface SetReport {
  name: string;
  kind: 'xaml' | 'css';
  out: string;
  /** Tokens other than the standard items. */
  tokens: number;
  /** Shared classes / rules (css). */
  rules: number;
  /** Standard items (xaml). */
  standard: number;
  /** Standard items that took the Aero2 value. */
  wpfDefault: number;
  dropped: number;
  warnings: TokenWarning[];
  errors: string[];
  /** The output file was (re)written (false when unchanged or not written). */
  written: boolean;
}

export interface GenerateReport {
  sets: SetReport[];
  /** Errors not tied to a set (no sets, unknown name, invalid config). */
  errors: string[];
  /** Config warnings (legacy string items, etc.). */
  warnings: string[];
  /** Paths written in this run (outputs and wpf-base.css). */
  written: string[];
}

export function hasErrors(report: GenerateReport): boolean {
  return report.errors.length > 0 || report.sets.some((s) => s.errors.length > 0);
}

/** Reads one set with the reader of its kind. */
export function readTokenSet(set: TokenSetConfig, fs: TokenFs): Promise<ReadResult> {
  return set.kind === 'xaml' ? new XamlReader().read(set, fs) : new CssReader().read(set, fs);
}

/** Renders one set (read + header + output) without writing. */
export async function renderTokenSet(set: TokenSetConfig, fs: TokenFs): Promise<{ result: ReadResult; text: string | null }> {
  const result = await readTokenSet(set, fs);
  if (result.errors.length) return { result, text: null };
  return { result, text: new TokenWriter().render(set, result, await configHash(set)) };
}

/** `ddv tokens generate` (`TGEN`): generates the selected sets and writes changed outputs. */
export async function generateTokens(config: DdvConfig, fs: TokenFs, opts: GenerateOptions = {}): Promise<GenerateReport> {
  const report: GenerateReport = { sets: [], errors: [], warnings: [], written: [] };
  const { sets, issues } = parseTokenSets(config);
  for (const i of issues) (i.severity === 'error' ? report.errors : report.warnings).push(i.message);
  if (!sets.length) {
    report.errors.push('tokens が未設定です');
    return report;
  }
  let targets = sets;
  if (opts.name !== undefined) {
    targets = sets.filter((s) => s.name === opts.name);
    if (!targets.length) {
      report.errors.push(`tokens に ${opts.name} のセットがありません`);
      return report;
    }
  }
  const write = async (path: string, text: string): Promise<boolean> => {
    if ((await fs.read(path)) === text) return false;
    if (!fs.write) throw new Error('TokenFs does not support write');
    await fs.write(path, text);
    report.written.push(path);
    return true;
  };
  const baseDirs = new Set<string>();
  for (const set of targets) {
    const { result, text } = await renderTokenSet(set, fs);
    const standard = result.tokens.filter((t) => t.kind === 'standard');
    const r: SetReport = {
      name: set.name,
      kind: set.kind,
      out: set.out,
      tokens: result.tokens.length - standard.length,
      rules: result.rules.length,
      standard: standard.length,
      wpfDefault: standard.filter((t) => t.origin === 'wpf-default').length,
      dropped: result.dropped,
      warnings: result.warnings,
      errors: result.errors,
      written: false,
    };
    report.sets.push(r);
    if (text === null) continue;
    r.written = await write(set.out, text);
    if (set.kind === 'xaml') baseDirs.add(dirname(set.out));
  }
  if (opts.wpfBaseCss !== undefined) {
    for (const dir of [...baseDirs].sort()) await write(joinPath(dir, WPF_BASE_FILE), opts.wpfBaseCss.replace(/\r\n?/g, '\n'));
  }
  return report;
}

const warningLine = (w: TokenWarning) => `  warning: ${w.file ? `${w.file}${w.line ? `:${w.line}` : ''} ` : ''}${w.message}`;

/** Text shown by `ddv tokens generate`. */
export function formatReport(report: GenerateReport): string {
  const lines: string[] = [];
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  for (const e of report.errors) lines.push(`error: ${e}`);
  for (const s of report.sets) {
    for (const e of s.errors) lines.push(`error: ${s.name}: ${e}`);
    if (!s.errors.length) {
      lines.push(`${s.name}: トークン ${s.tokens} 件・共通クラス ${s.rules} 件・標準の項目 ${s.standard} 件（WPF 標準 ${s.wpfDefault} 件）・負けた定義 ${s.dropped} 件 → ${s.out}`);
    }
    for (const w of s.warnings) lines.push(warningLine(w));
  }
  return lines.join('\n');
}
