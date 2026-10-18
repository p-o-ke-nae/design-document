// `evidence` of ddv.config.yaml (detailed design evidence-runner.md#設定, evidence-spec.md#設定の検査). Browser-safe.
import { z } from 'zod';
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, type Scalar } from './spec.ts';

export const DB_TYPES = ['sqlite', 'sqlserver', 'postgres'] as const;
export type DbType = (typeof DB_TYPES)[number];
/** Reserved database name: the mock's pseudo DB. */
export const MOCK_DB = 'mock';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const TimeoutSchema = z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS);

export const ParamDefSchema = z.strictObject({ required: z.boolean().default(false), default: ScalarSchema.optional() });

/** `type` / `env` are checked after the schema (CFGCHK E2・E3) so that their own messages are reported. */
export const DatabaseSchema = z.strictObject({
  type: z.string(),
  env: z.string().regex(ENV_NAME, { error: (iss) => `env は環境変数の名前（英数字と _）で書いてください: ${String(iss.input)}` }).optional(),
  mask: z.array(z.string()).default([]),
});

/** `run` is checked after the schema (CFGCHK E5). */
export const CommandSchema = z.strictObject({
  run: z.string().optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().default('.'),
  params: z.record(z.string(), ParamDefSchema).default({}),
  output: z.enum(['dir', 'stdout']).default('dir'),
  timeout: TimeoutSchema.optional(),
});

export const EvidenceConfigSchema = z
  .strictObject({
    timeout: TimeoutSchema.default(30_000),
    maxRows: z.number().int().min(1).max(10_000).default(200),
    maxBytes: z.number().int().min(1024).max(10_485_760).default(1_048_576),
    maxFileBytes: z.number().int().min(1024).max(52_428_800).default(5_242_880),
    defaultDatabase: z.string().min(1).optional(),
    databases: z.record(z.string(), DatabaseSchema).default({}),
    commands: z.record(z.string(), CommandSchema).default({}),
  })
  .superRefine((v, ctx) => {
    if (MOCK_DB in v.databases) ctx.addIssue({ code: 'custom', path: ['databases', MOCK_DB], message: `接続先の名前 ${MOCK_DB} は使えません` });
  });

export interface ParamDef {
  required: boolean;
  default?: Scalar;
}
export interface DatabaseConfig {
  type: DbType;
  env: string;
  mask: string[];
}
export interface CommandConfig {
  run: string;
  args: string[];
  cwd: string;
  params: Record<string, ParamDef>;
  output: 'dir' | 'stdout';
  timeout?: number;
}
export interface EvidenceConfig {
  timeout: number;
  maxRows: number;
  maxBytes: number;
  maxFileBytes: number;
  defaultDatabase?: string;
  databases: Record<string, DatabaseConfig>;
  commands: Record<string, CommandConfig>;
}

export interface EvidenceConfigResult {
  /** Usable config: defaults when the schema fails; databases / commands with errors are left out. */
  config: EvidenceConfig;
  errors: string[];
}

const defaults = (): EvidenceConfig => EvidenceConfigSchema.parse({}) as EvidenceConfig;

/** Checks `evidence` of the config (CFGCHK) and returns the usable part. `undefined` = defaults, no errors (REQ-810). */
export function parseEvidenceConfig(raw: unknown): EvidenceConfigResult {
  if (raw === undefined || raw === null) return { config: defaults(), errors: [] };
  const r = EvidenceConfigSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    return { config: defaults(), errors: [`設定 evidence の形式が不正です: ${['evidence', ...i.path.map(String)].join('.')}: ${i.message}`] };
  }
  const v = r.data;
  const errors: string[] = [];
  const databases: Record<string, DatabaseConfig> = {};
  for (const [name, db] of Object.entries(v.databases)) {
    if (!(DB_TYPES as readonly string[]).includes(db.type)) {
      errors.push(`接続先 ${name} の type が不明です: ${db.type}（${DB_TYPES.join(' / ')}）`);
      continue;
    }
    if (!db.env) {
      errors.push(`接続先 ${name} に env（接続文字列の環境変数の名前）が必要です`);
      continue;
    }
    databases[name] = { type: db.type as DbType, env: db.env, mask: db.mask };
  }
  if (v.defaultDatabase !== undefined && v.defaultDatabase !== MOCK_DB && !(v.defaultDatabase in v.databases)) {
    errors.push(`defaultDatabase の接続先 ${v.defaultDatabase} がありません（mock か evidence.databases の名前）`);
  }
  const commands: Record<string, CommandConfig> = {};
  for (const [name, c] of Object.entries(v.commands)) {
    if (!c.run?.trim()) {
      errors.push(`取得手段 ${name} の run（実行ファイル）が必要です`);
      continue;
    }
    commands[name] = { ...c, run: c.run } as CommandConfig;
  }
  return { config: { ...v, databases, commands } as EvidenceConfig, errors };
}

/** Usable evidence config of a ddv config (`config.evidence`), ignoring errors. */
export function evidenceConfigOf(config: { evidence?: unknown }): EvidenceConfig {
  return parseEvidenceConfig(config.evidence).config;
}
