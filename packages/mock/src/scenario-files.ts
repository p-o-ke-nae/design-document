import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parseConfig, type DdvConfig } from '@ddv/core';
import { CONFIG_FILES } from '@ddv/core/node';
import { RETIRED_DIR } from './scaffold-cli.ts';

export interface ScenarioEntry {
  /** Mock folder name under mocksRoot. */
  mock: string;
  /** Repository-relative posix path. */
  file: string;
  retired: boolean;
}

/** Synchronous `loadConfig` (Playwright declares tests synchronously). */
export function loadConfigSync(repoRoot: string): DdvConfig {
  for (const name of CONFIG_FILES) {
    const p = path.join(repoRoot, name);
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8');
      return parseConfig(name.endsWith('.json') ? JSON.parse(text) : YAML.parse(text));
    }
  }
  return parseConfig({});
}

export const mocksRootOf = (config: DdvConfig) => config.mocksRoot.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');

const yamlFiles = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name) && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

/** `<mocksRoot>/<mock>/scenarios/*.yaml` (and `_retired/*.yaml` when `retired`), excluding `_map.yaml` and other `_` files. */
export function findScenarioFiles(repoRoot: string, config: DdvConfig, opts: { retired?: boolean } = {}): ScenarioEntry[] {
  const root = mocksRootOf(config);
  const absRoot = path.join(repoRoot, root);
  if (!existsSync(absRoot)) return [];
  const out: ScenarioEntry[] = [];
  const mocks = readdirSync(absRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  for (const mock of mocks) {
    const dir = `${root}/${mock}/scenarios`;
    for (const f of yamlFiles(path.join(repoRoot, dir))) out.push({ mock, file: `${dir}/${f}`, retired: false });
    if (opts.retired) for (const f of yamlFiles(path.join(repoRoot, dir, RETIRED_DIR))) out.push({ mock, file: `${dir}/${RETIRED_DIR}/${f}`, retired: true });
  }
  return out;
}

/** The `id:` value of a scenario text even when the file is otherwise invalid. */
export function scenarioIdOf(text: string): string | null {
  return /^id:\s*["']?([^"'#\s]+)/m.exec(text)?.[1] ?? null;
}
