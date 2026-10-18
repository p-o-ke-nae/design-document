// JUnit report of `ddv desktop run` (read back by `parseJUnit` of the server).
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DesktopCaseResult {
  id: string;
  title: string;
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  message?: string;
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // characters XML 1.0 cannot hold
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** `<testcase name="[ID] title" classname="<runner>">`; failed → `<failure>`, error → `<error>`. */
export function junitXml(runner: string, cases: readonly DesktopCaseResult[]): string {
  const failures = cases.filter((c) => c.status === 'failed').length;
  const errors = cases.filter((c) => c.status === 'error').length;
  const total = cases.reduce((s, c) => s + c.durationMs, 0) / 1000;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="ddv desktop run" tests="${cases.length}" failures="${failures}" errors="${errors}" time="${total.toFixed(3)}">`,
    `  <testsuite name="${esc(runner)}" tests="${cases.length}" failures="${failures}" errors="${errors}" time="${total.toFixed(3)}">`,
  ];
  for (const c of cases) {
    const head = `    <testcase name="${esc(`[${c.id}] ${c.title}`)}" classname="${esc(runner)}" time="${(c.durationMs / 1000).toFixed(3)}"`;
    if (c.status === 'passed') {
      lines.push(`${head}/>`);
      continue;
    }
    const tag = c.status === 'failed' ? 'failure' : 'error';
    const msg = c.message ?? '';
    lines.push(`${head}>`, `      <${tag} message="${esc(msg.split(/\r?\n/)[0] ?? '')}">${esc(msg)}</${tag}>`, '    </testcase>');
  }
  lines.push('  </testsuite>', '</testsuites>', '');
  return lines.join('\n');
}

export async function writeJUnit(file: string, runner: string, cases: readonly DesktopCaseResult[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, junitXml(runner, cases));
}
