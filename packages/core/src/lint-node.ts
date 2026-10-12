import { existsSync } from 'node:fs';
import type { DdvConfig } from './config.ts';
import type { DocEntry } from './doc.ts';
import { lintDocsWith, lintTargets, type LintIssue } from './lint.ts';
import { loadDocs, safeJoin } from './node.ts';

export type ExtraLintCheck = (repoRoot: string, config: DdvConfig, docs: DocEntry[]) => Promise<LintIssue[]> | LintIssue[];

export async function lintRepo(repoRoot: string, config: DdvConfig, opts: { extraChecks?: ExtraLintCheck[] } = {}): Promise<LintIssue[]> {
  const docs = await loadDocs(repoRoot, config);
  const issues = lintDocs(repoRoot, config, docs);
  for (const check of opts.extraChecks ?? []) issues.push(...(await check(repoRoot, config, docs)));
  return issues;
}

export function lintDocs(repoRoot: string, config: DdvConfig, docs: DocEntry[]): LintIssue[] {
  const existing = new Set(lintTargets(docs, config).filter((p) => existsSync(safeJoin(repoRoot, p))));
  return lintDocsWith(existing, config, docs);
}
