import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgs = path.resolve(here, '../..');

// ブラウザ（Pages 版）で解決されるエントリ。vite.config の alias と揃える
const browserEntries: Record<string, string> = {
  '@ddv/core': 'core/src/index.ts',
  '@ddv/github': 'github/src/browser.ts',
  '@ddv/graph': 'graph/src/index.ts',
  '@ddv/mock/browser': 'mock/src/browser-safe.ts',
  '@ddv/mock/yaml-patch': 'mock/src/yaml-patch.ts',
  '@ddv/testid/core': 'testid/src/core.ts',
  '@ddv/services': 'services/src/index.ts',
};
const builtins = new Set(builtinModules);
const SPEC = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

function sources(): string[] {
  return readdirSync(here)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(here, f));
}

function walk(): { violations: string[]; seen: Set<string> } {
  const seen = new Set<string>();
  const violations: string[] = [];
  const stack = sources();
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(pkgs, file).replaceAll('\\', '/');
    for (const m of text.matchAll(SPEC)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('node:') || builtins.has(spec) || builtins.has(spec.split('/')[0])) {
        violations.push(`${rel} → ${spec}`);
      } else if (spec.startsWith('.')) {
        stack.push(path.resolve(path.dirname(file), spec));
      } else if (spec.startsWith('@ddv/')) {
        const entry = browserEntries[spec];
        if (!entry) violations.push(`${rel} → ${spec}（ブラウザ用の入口がない）`);
        else stack.push(path.join(pkgs, entry));
      }
    }
    if (/\bprocess\.(env|cwd|platform|argv|exit)\b/.test(text)) violations.push(`${rel} → process`);
  }
  return { violations, seen };
}

describe('@ddv/services はブラウザで動く', () => {
  it('services とそこから辿れる @ddv/* のブラウザ用入口は node:* ・child_process・process を使わない', () => {
    const { violations, seen } = walk();
    expect(seen.size).toBeGreaterThan(sources().length);
    expect(violations).toEqual([]);
  });
});