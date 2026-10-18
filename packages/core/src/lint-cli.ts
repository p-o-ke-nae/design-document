#!/usr/bin/env node
import path from 'node:path';
import { loadConfig } from './node.ts';
import { formatIssues } from './lint.ts';
import { lintRepo } from './lint-node.ts';

const args = process.argv.slice(2);
const repoIdx = args.indexOf('--repo');
const repo = path.resolve(repoIdx >= 0 ? args[repoIdx + 1] : '.');
const json = args.includes('--json');
const strict = args.includes('--strict');

const config = await loadConfig(repo);
// @ddv/mock and @ddv/tokens depend on core, so they are loaded dynamically to avoid a static import cycle.
const { checkMocks } = await import('@ddv/mock');
const { checkTokens } = await import('@ddv/tokens/node');
const { checkEvidence } = await import('@ddv/evidence/check');
const issues = await lintRepo(repo, config, { extraChecks: [checkMocks, checkTokens, checkEvidence] });
if (json) {
  console.log(JSON.stringify(issues, null, 2));
} else {
  console.log(issues.length ? formatIssues(issues) : '✓ 問題はありません');
  const errors = issues.filter((i) => i.severity === 'error').length;
  console.log(`\nerrors: ${errors}, warnings: ${issues.length - errors}`);
}
const failed = issues.some((i) => i.severity === 'error' || (strict && i.severity === 'warning'));
process.exit(failed ? 1 : 0);
