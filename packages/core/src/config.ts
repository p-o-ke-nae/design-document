import { z } from 'zod';

export const RunnerSchema = z.object({
  name: z.string(),
  type: z.enum(['vitest', 'playwright', 'dotnet', 'command']),
  /** Working directory relative to the repository root. */
  cwd: z.string().default('.'),
  level: z.enum(['unit', 'integration']).default('unit'),
  /** Globs (relative to cwd) of test sources scanned for test ids. */
  include: z.array(z.string()).optional(),
  /** For `command` runners: command line with `{pattern}`, `{ids}` and `{junit}` placeholders. */
  command: z.string().optional(),
  /** Playwright runners: also link scenario YAML files under mocksRoot by their `id`. */
  scenarios: z.boolean().default(false),
});

export const ConfigSchema = z.object({
  docsRoot: z.string().default('docs'),
  mocksRoot: z.string().default('docs/mocks'),
  /** Optional external documentation repository (Phase 3). */
  source: z.object({ repo: z.string(), branch: z.string().default('main') }).optional(),
  idPrefix: z
    .object({
      requirements: z.string().default('REQ'),
      basic: z.string().default('BD'),
      detailed: z.string().default('DD'),
    })
    .prefault({}),
  toc: z.object({ minLevel: z.number().int().min(1).max(6).default(2), maxLevel: z.number().int().min(1).max(6).default(3) }).prefault({}),
  matrix: z
    .object({
      nSwitch: z.number().int().min(0).default(1),
      loopLimit: z.number().int().min(0).default(1),
      maxPaths: z.number().int().min(1).default(200),
    })
    .prefault({}),
  styles: z.array(z.string()).default([]),
  tokens: z.array(z.string()).default([]),
  runners: z.array(RunnerSchema).default([]),
  mock: z
    .object({
      browser: z.object({ channel: z.string().default('chromium') }).prefault({}),
      snapshot: z
        .object({
          threshold: z.number().min(0).max(1).default(0.001),
          viewport: z.object({ width: z.number().int().min(1).default(1280), height: z.number().int().min(1).default(800) }).prefault({}),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type DdvConfig = z.infer<typeof ConfigSchema>;
export type RunnerConfig = z.infer<typeof RunnerSchema>;

export function parseConfig(raw: unknown): DdvConfig {
  return ConfigSchema.parse(raw ?? {});
}

export type DocKind = 'requirements' | 'basic' | 'detailed' | 'other';

export function inferDocKind(path: string, frontKind?: unknown): DocKind {
  if (frontKind === 'requirements' || frontKind === 'basic' || frontKind === 'detailed') return frontKind;
  const p = path.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(requirements?|req|要件定義)(\/|$)/.test(p)) return 'requirements';
  if (/(^|\/)(basic|基本設計)(\/|$)/.test(p)) return 'basic';
  if (/(^|\/)(detailed|detail|詳細設計)(\/|$)/.test(p)) return 'detailed';
  return 'other';
}
