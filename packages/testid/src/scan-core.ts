import YAML from 'yaml';
import type { DdvConfig, RunnerConfig } from '@ddv/core';
import { idPattern } from './lock.ts';

export interface TestLink {
  id: string;
  runner: string;
  level: 'unit' | 'integration';
  file: string;
  line: number;
  /** JS: test title. .NET: fully qualified method name. */
  test: string;
}

const JS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Minimal glob → RegExp (`**`, `*`, `?`, `{a,b}`), matched against posix paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = end;
    } else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function runnerFilter(r: RunnerConfig): (relToCwd: string) => boolean {
  if (r.include?.length) {
    const res = r.include.map(globToRegExp);
    return (p) => res.some((x) => x.test(p));
  }
  if (r.type === 'dotnet') return (p) => p.endsWith('.cs');
  return (p) => JS_TEST.test(p);
}

function jsTitle(line: string): string {
  const m = /\b(?:test|it|describe)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(line);
  return m ? m[2] : '';
}

function csMethod(lines: string[], from: number): string {
  let method = '';
  for (let i = from; i < Math.min(lines.length, from + 12); i++) {
    const m = /(?:^|\s)(?:void|Task(?:<[^>]+>)?)\s+([\p{L}\p{N}_]+)\s*\(/u.exec(lines[i]);
    if (m) {
      method = m[1];
      break;
    }
  }
  let cls = '';
  let ns = '';
  for (let i = from; i >= 0; i--) {
    if (!cls) {
      const m = /(?:^|\s)class\s+([\p{L}\p{N}_]+)/u.exec(lines[i]);
      if (m) cls = m[1];
    }
    const n = /^\s*namespace\s+([\w.]+)/.exec(lines[i]);
    if (n) {
      ns = n[1];
      break;
    }
  }
  return [ns, cls, method].filter(Boolean).join('.');
}

/** Filter of repo-relative paths for the test files of one runner (`runnerFilter` applied relative to `cwd`). */
export function runnerFileFilter(r: RunnerConfig): (rel: string) => boolean {
  const base = r.cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const filter = runnerFilter(r);
  return (rel) => filter(base === '.' || base === '' ? rel : rel.slice(base.length + 1));
}

/** Id pattern of the configured prefixes. */
export function testIdPattern(config: DdvConfig): RegExp {
  return idPattern(Object.values(config.idPrefix));
}

/** Links found in one test source file. */
export function linksInText(text: string, file: string, r: RunnerConfig, re: RegExp): TestLink[] {
  const links: TestLink[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // JS test frameworks: only test declarations (title or Playwright tag) count as links, not ids used as data.
    if ((r.type === 'vitest' || r.type === 'playwright') && !jsTitle(line) && !/\btag\s*:/.test(line)) return;
    for (const m of line.matchAll(re)) {
      links.push({
        id: m[0],
        runner: r.name,
        level: r.level,
        file,
        line: i + 1,
        test: r.type === 'dotnet' ? csMethod(lines, i) : jsTitle(line) || line.trim(),
      });
    }
  });
  return links;
}

/** Scenario YAML files (`<mocksRoot>/<name>/scenarios/*.yaml`, not `_*`) linked by Playwright runners with `scenarios`. */
export function isScenarioLinkFile(rel: string): boolean {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  return parts[parts.length - 2] === 'scenarios' && /\.ya?ml$/.test(name) && !name.startsWith('_');
}

/** Links of one scenario YAML file by its `id` line. */
export function scenarioLinksInText(text: string, file: string, r: RunnerConfig, re: RegExp): TestLink[] {
  let title = '';
  try {
    const v = YAML.parse(text) as { title?: unknown } | null;
    if (v && typeof v.title === 'string') title = v.title;
  } catch {
    /* invalid YAML: still link by the id line */
  }
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^id\s*:/.test(l));
  if (i < 0) return [];
  return [...lines[i].matchAll(re)].map((m) => ({ id: m[0], runner: r.name, level: r.level, file, line: i + 1, test: title || m[0] }));
}