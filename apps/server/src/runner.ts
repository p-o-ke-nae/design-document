import { spawn } from 'node:child_process';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { RunnerConfig } from '@ddv/core';
import { safeJoin } from '@ddv/core/node';
import type { TestLink } from '@ddv/testid';

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface CaseResult {
  status: TestStatus;
  durationMs: number;
  message?: string;
  runner: string;
  test: string;
}

export interface RawResult {
  name: string;
  status: TestStatus;
  durationMs: number;
  message?: string;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : undefined;
}

export function parseJUnit(xml: string): RawResult[] {
  const out: RawResult[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const head = m[1];
    const body = m[3] ?? '';
    const name = attr(head, 'name') ?? '';
    const cls = attr(head, 'classname') ?? '';
    const time = Number(attr(head, 'time') ?? '0');
    let status: TestStatus = 'passed';
    let message: string | undefined;
    const fail = /<(failure|error)\b([^>]*)>?([\s\S]*?)(?:<\/\1>|$)/.exec(body);
    if (fail) {
      status = 'failed';
      message = (attr(fail[2], 'message') ?? decodeXml(fail[3] ?? '')).trim().slice(0, 4000);
    } else if (/<skipped\b/.test(body)) status = 'skipped';
    out.push({ name: `${cls} ${name}`, status, durationMs: Math.round(time * 1000), message });
  }
  return out;
}

function parseTrxDuration(d: string | undefined): number {
  const m = /^(\d+):(\d+):([\d.]+)$/.exec(d ?? '');
  return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : 0;
}

export function parseTrx(xml: string): RawResult[] {
  const out: RawResult[] = [];
  const re = /<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g;
  for (const m of xml.matchAll(re)) {
    const outcome = attr(m[1], 'outcome') ?? '';
    const status: TestStatus = outcome === 'Passed' ? 'passed' : outcome === 'NotExecuted' ? 'skipped' : 'failed';
    const msg = /<Message>([\s\S]*?)<\/Message>/.exec(m[3] ?? '');
    out.push({ name: attr(m[1], 'testName') ?? '', status, durationMs: parseTrxDuration(attr(m[1], 'duration')), message: msg ? decodeXml(msg[1]).trim() : undefined });
  }
  return out;
}

function resolveBin(cwd: string, pkg: string, bin: string): string {
  const req = createRequire(path.join(cwd, '__ddv__.js'));
  const pkgJson = req.resolve(`${pkg}/package.json`);
  const meta = JSON.parse(readFileSync(pkgJson, 'utf8'));
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin[bin];
  return path.join(path.dirname(pkgJson), rel);
}

export interface RunnerInvocation {
  command: string;
  args: string[];
  shell: boolean;
  reportPath: string;
  reportType: 'junit' | 'trx';
  env?: Record<string, string>;
}

export function buildInvocation(repoRoot: string, runner: RunnerConfig, ids: string[] | null, reportDir: string, links: TestLink[] = []): RunnerInvocation {
  const cwd = safeJoin(repoRoot, runner.cwd);
  const pattern = ids?.length ? ids.join('|') : '';
  switch (runner.type) {
    case 'vitest': {
      const reportPath = path.join(reportDir, `${runner.name}.junit.xml`);
      const args = [resolveBin(cwd, 'vitest', 'vitest'), 'run', '--reporter=default', '--reporter=junit', `--outputFile.junit=${reportPath}`];
      if (pattern) args.push('-t', pattern);
      return { command: process.execPath, args, shell: false, reportPath, reportType: 'junit' };
    }
    case 'playwright': {
      const reportPath = path.join(reportDir, `${runner.name}.junit.xml`);
      const args = [resolveBin(cwd, '@playwright/test', 'playwright'), 'test', '--reporter=line,junit'];
      if (pattern) args.push('--grep', pattern);
      return { command: process.execPath, args, shell: false, reportPath, reportType: 'junit', env: { PLAYWRIGHT_JUNIT_OUTPUT_FILE: reportPath, PLAYWRIGHT_JUNIT_OUTPUT_NAME: reportPath } };
    }
    case 'dotnet': {
      const reportPath = path.join(reportDir, `${runner.name}.trx`);
      const args = ['test', '--logger', `trx;LogFileName=${reportPath}`];
      if (ids?.length) {
        // Filter by fully qualified method name so xUnit / NUnit / MSTest all work regardless of how the ID is attached.
        const fqns = [...new Set(links.filter((l) => l.runner === runner.name && ids.includes(l.id) && l.test).map((l) => l.test))];
        args.push('--filter', fqns.length ? fqns.map((n) => `FullyQualifiedName=${n}`).join('|') : ids.map((id) => `TestId=${id}`).join('|'));
      }
      return { command: 'dotnet', args, shell: false, reportPath, reportType: 'trx' };
    }
    case 'command': {
      const reportPath = path.join(reportDir, `${runner.name}.junit.xml`);
      if (!runner.command) throw new Error(`runner ${runner.name}: command がありません`);
      const cmd = runner.command
        .replaceAll('{pattern}', JSON.stringify(pattern || '.*'))
        .replaceAll('{ids}', (ids ?? []).join(' '))
        .replaceAll('{junit}', JSON.stringify(reportPath));
      return { command: cmd, args: [], shell: true, reportPath, reportType: 'junit' };
    }
  }
}

export interface ExecOutcome {
  exitCode: number | null;
  results: Record<string, CaseResult>;
  command: string;
  error?: string;
}

/** Maps raw runner results to test ids using the scanned links. */
export function mapResults(runner: RunnerConfig, raw: RawResult[], links: TestLink[], idRe: RegExp, requested: Set<string> | null): Record<string, CaseResult> {
  const out: Record<string, CaseResult> = {};
  const byTest = new Map<string, string[]>();
  for (const l of links) if (l.runner === runner.name) byTest.set(l.test, [...(byTest.get(l.test) ?? []), l.id]);
  for (const r of raw) {
    const ids = new Set<string>(r.name.match(new RegExp(idRe.source, 'g')) ?? []);
    for (const [test, list] of byTest) if (test && (r.name === test || r.name.endsWith(` ${test}`) || r.name.endsWith(`.${test}`))) list.forEach((i) => ids.add(i));
    for (const id of ids) {
      if (requested && !requested.has(id)) continue;
      const prev = out[id];
      const rank = { failed: 3, error: 3, passed: 2, skipped: 1 } as const;
      if (!prev || rank[r.status] > rank[prev.status]) out[id] = { status: r.status, durationMs: r.durationMs, message: r.message, runner: runner.name, test: r.name.trim() };
      else prev.durationMs += r.durationMs;
    }
  }
  return out;
}

export async function executeRunner(
  repoRoot: string,
  runner: RunnerConfig,
  ids: string[] | null,
  links: TestLink[],
  idRe: RegExp,
  onLog: (line: string) => void,
): Promise<ExecOutcome> {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-run-'));
  let inv: RunnerInvocation;
  try {
    inv = buildInvocation(repoRoot, runner, ids, reportDir, links);
  } catch (e) {
    return { exitCode: null, results: {}, command: '', error: (e as Error).message };
  }
  const commandLine = [inv.command === process.execPath ? 'node' : inv.command, ...inv.args].join(' ');
  onLog(`$ ${commandLine}`);
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(inv.command, inv.args, {
      cwd: safeJoin(repoRoot, runner.cwd),
      shell: inv.shell,
      env: { ...process.env, ...inv.env, FORCE_COLOR: '0', NO_COLOR: '1', DOTNET_CLI_UI_LANGUAGE: process.env.DOTNET_CLI_UI_LANGUAGE ?? 'ja' },
      windowsHide: true,
    });
    const pipe = (buf: Buffer) => buf.toString('utf8').split(/\r?\n/).filter((l) => l.length).forEach(onLog);
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
    child.on('error', (e) => {
      onLog(`! ${e.message}`);
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
  let raw: RawResult[] = [];
  if (existsSync(inv.reportPath)) {
    const xml = await fs.readFile(inv.reportPath, 'utf8');
    raw = inv.reportType === 'trx' ? parseTrx(xml) : parseJUnit(xml);
  } else onLog(`! レポート ${inv.reportPath} が出力されませんでした`);
  await fs.rm(reportDir, { recursive: true, force: true });
  const requested = ids ? new Set(ids) : null;
  return { exitCode, results: mapResults(runner, raw, links, idRe, requested), command: commandLine };
}
