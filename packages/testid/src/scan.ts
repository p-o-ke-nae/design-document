import { promises as fs } from 'node:fs';
import YAML from 'yaml';
import type { DdvConfig, RunnerConfig } from '@ddv/core';
import { safeJoin, walk } from '@ddv/core/node';
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

function runnerFilter(r: RunnerConfig): (relToCwd: string) => boolean {
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

export async function scanTestLinks(repoRoot: string, config: DdvConfig): Promise<TestLink[]> {
  const re = idPattern(Object.values(config.idPrefix));
  const links: TestLink[] = [];
  for (const r of config.runners) {
    const base = r.cwd.replace(/\\/g, '/').replace(/\/$/, '');
    const filter = runnerFilter(r);
    const files = await walk(repoRoot, r.cwd, (rel) => filter(base === '.' || base === '' ? rel : rel.slice(base.length + 1)));
    for (const file of files) {
      const text = await fs.readFile(safeJoin(repoRoot, file), 'utf8');
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
    }
    if (r.type === 'playwright' && r.scenarios) links.push(...(await scanScenarioLinks(repoRoot, config, r, re)));
  }
  return links;
}

/** Links scenario YAML files (`<mocksRoot>/<name>/scenarios/*.yaml`) by their `id` line. */
async function scanScenarioLinks(repoRoot: string, config: DdvConfig, r: RunnerConfig, re: RegExp): Promise<TestLink[]> {
  const out: TestLink[] = [];
  const files = await walk(repoRoot, config.mocksRoot, (rel) => {
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    return parts[parts.length - 2] === 'scenarios' && /\.ya?ml$/.test(name) && !name.startsWith('_');
  });
  for (const file of files) {
    const text = await fs.readFile(safeJoin(repoRoot, file), 'utf8');
    let title = '';
    try {
      const v = YAML.parse(text) as { title?: unknown } | null;
      if (v && typeof v.title === 'string') title = v.title;
    } catch {
      /* invalid YAML: still link by the id line */
    }
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => /^id\s*:/.test(l));
    if (i < 0) continue;
    for (const m of lines[i].matchAll(re)) out.push({ id: m[0], runner: r.name, level: r.level, file, line: i + 1, test: title || m[0] });
  }
  return out;
}
