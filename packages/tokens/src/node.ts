import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { type DdvConfig, type LintIssue } from '@ddv/core';
import { safeJoin, walk } from '@ddv/core/node';
import { checkTokenSets, type TokenCheckResult } from './drift.ts';
import { globListed, globToRegExp, normalizePath, type TokenFs } from './fs.ts';
import { generateTokens, type GenerateOptions, type GenerateReport } from './generate.ts';

export * from './index.ts';

/** `TokenFs` over the local file system. Reads may leave the repository (`../pokenae.Web/…`); writes may not. */
export class NodeTokenFs implements TokenFs {
  private files: string[] | null = null;

  constructor(readonly repoRoot: string) {}

  async read(rel: string): Promise<string | null> {
    try {
      const text = await fsp.readFile(path.resolve(this.repoRoot, normalizePath(rel)), 'utf8');
      return text.replace(/^\uFEFF/, '');
    } catch {
      return null;
    }
  }

  async glob(pattern: string): Promise<string[]> {
    this.files ??= await walk(this.repoRoot, '', () => true);
    const re = globToRegExp(pattern);
    return this.files.filter((f) => globListed(f, re));
  }

  async write(rel: string, text: string): Promise<void> {
    const abs = safeJoin(this.repoRoot, normalizePath(rel));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text, 'utf8');
  }
}

/** The bundled `assets/wpf-base.css`. */
export async function loadWpfBaseCss(): Promise<string> {
  return fsp.readFile(new URL('../assets/wpf-base.css', import.meta.url), 'utf8');
}

const optionalEnv = () => process.env.DDV_TOKENS_OPTIONAL === '1';

/** `ddv tokens check` (issues and infos). */
export function checkTokensDetailed(repoRoot: string, config: DdvConfig): Promise<TokenCheckResult> {
  return checkTokenSets(config, new NodeTokenFs(repoRoot), { optionalEnv: optionalEnv() });
}

/** Drift check for `lintRepo` (`ExtraLintCheck`): rule `tokens` at the output file, `tokens-config` at the config. */
export async function checkTokens(repoRoot: string, config: DdvConfig): Promise<LintIssue[]> {
  if (!config.tokens.length) return [];
  return (await checkTokensDetailed(repoRoot, config)).issues;
}

/** `ddv tokens generate` on the local file system. */
export async function generateTokensAt(repoRoot: string, config: DdvConfig, opts: Omit<GenerateOptions, 'wpfBaseCss'> = {}): Promise<GenerateReport> {
  return generateTokens(config, new NodeTokenFs(repoRoot), { ...opts, wpfBaseCss: await loadWpfBaseCss() });
}

