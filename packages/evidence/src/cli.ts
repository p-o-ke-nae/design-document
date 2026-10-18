// `ddv evidence <list | try>` (detailed design evidence-spec.md#ddv-evidence).
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '@ddv/core/node';
import { MOCK_DB, parseEvidenceConfig, type EvidenceConfig } from './config.ts';
import { loadRegistry, type EvidenceRegistry, type ProviderInfo } from './registry.ts';
import { normalizeSpec, type EvidenceSpec, type Scalar } from './spec.ts';
import { defaultTryCapture } from './try-capture.ts';

export const EVIDENCE_HELP = `ddv evidence list [--repo <path>] [--json]
      使える取得手段（組み込み・hooks・外部コマンド）と引数、接続先（名前・種類・環境変数の有無）を表示します
  ddv evidence try <名前> [--repo <path>] [--with key=value ...] [--db <接続先>] [--out <dir>] [--timeout <ms>]
      1 つの取得手段をその場で実行し、結果の種類・ファイル・大きさ・時間を表示します（画面の操作はしません）`;

/** One file of a `try` result. */
export interface TryFile {
  kind: string;
  path: string;
  bytes: number;
}

export interface TryResult {
  status: 'ok' | 'failed';
  /** Reason after redaction (failed). */
  reason?: string;
  files: TryFile[];
  durationMs: number;
}

export interface TryRequest {
  repoRoot: string;
  config: EvidenceConfig;
  registry: EvidenceRegistry;
  /** `with` built from `--with` / `--db`; `at: after`, no driver, empty input. */
  spec: EvidenceSpec;
  outDir: string;
}

/** Captures one spec without a driver (`EvidenceRunner.captureOne`). Injected in tests; the runner stage provides the real one. */
export type TryCapture = (req: TryRequest) => Promise<TryResult>;

export interface EvidenceIo {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  help?: string;
  capture?: TryCapture;
  now?: () => Date;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function args(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  });
  return out;
}

/** `--with` values: `true` / `false` / numbers are converted; a repeated key becomes an array. */
export function parseWithArgs(values: string[]): Record<string, Scalar | Scalar[]> {
  const out: Record<string, Scalar | Scalar[]> = {};
  for (const v of values) {
    const eq = v.indexOf('=');
    if (eq <= 0) throw new TryArgError(`--with は key=value で書いてください: ${v}`);
    const key = v.slice(0, eq);
    const raw = v.slice(eq + 1);
    const value: Scalar = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    const cur = out[key];
    out[key] = cur === undefined ? value : Array.isArray(cur) ? [...cur, value] : [cur, value];
  }
  return out;
}

class TryArgError extends Error {}

function paramsText(p: ProviderInfo): string {
  if (!p.paramsKnown) return '（読めません）';
  const names = Object.entries(p.params).map(([n, d]) => `${n}${d.required ? '*' : ''}${d.default !== undefined ? `=${String(d.default)}` : ''}`);
  return names.length ? names.join(', ') : '-';
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => [...r[i]].length)));
  return rows.map((r) => r.map((c, i) => c + ' '.repeat(widths[i] - [...c].length)).join('  ').trimEnd());
}

async function list(repoRoot: string, json: boolean, io: EvidenceIo, env: NodeJS.ProcessEnv): Promise<number> {
  const config = await loadConfig(repoRoot);
  const parsed = parseEvidenceConfig(config.evidence);
  const registry = await loadRegistry(repoRoot, config);
  const issues = [
    ...parsed.errors.map((message) => ({ severity: 'error' as const, source: 'ddv.config.yaml', message })),
    ...registry.issues,
  ];
  const providers = [...registry.providers.values()];
  const databases = [...registry.databases.entries()].map(([name, d]) => ({ name, type: d.type, env: d.env, present: !!env[d.env] }));
  if (json) {
    io.out(JSON.stringify({ providers, databases, issues }, null, 2));
  } else {
    io.out('取得手段');
    for (const l of table([
      ['名前', '種類', '引数', '時間の上限'],
      ...providers.map((p) => [p.name, p.kind, paramsText(p), `${p.timeout ?? parsed.config.timeout} ms`]),
    ]))
      io.out(`  ${l}`);
    io.out('');
    io.out('接続先');
    if (databases.length) for (const l of table([['名前', '種類', '環境変数', '有無'], ...databases.map((d) => [d.name, d.type, d.env, d.present ? 'あり' : 'なし'])])) io.out(`  ${l}`);
    else io.out('  （なし）');
    if (issues.length) {
      io.out('');
      for (const i of issues) io.out(`${i.severity}: ${i.source}: ${i.message}`);
    }
  }
  return issues.length ? 1 : 0;
}

async function tryOne(repoRoot: string, argv: string[], io: EvidenceIo): Promise<number> {
  const name = argv[1];
  if (!name || name.startsWith('--')) {
    io.err(`取得手段の名前を指定してください\n\n${io.help ?? EVIDENCE_HELP}`);
    return 2;
  }
  const config = await loadConfig(repoRoot);
  const parsed = parseEvidenceConfig(config.evidence);
  const registry = await loadRegistry(repoRoot, config);
  const info = registry.get(name);
  if (!info) {
    io.err(`取得手段 ${name} は登録されていません`);
    return 2;
  }
  if (info.name === 'screenshot') {
    io.err('screenshot は画面の操作が要るため try では使えません');
    return 2;
  }
  let w: Record<string, Scalar | Scalar[]>;
  try {
    w = parseWithArgs(args(argv, '--with'));
  } catch (e) {
    if (!(e instanceof TryArgError)) throw e;
    io.err(e.message);
    return 2;
  }
  const db = arg(argv, '--db');
  if (db !== undefined) w.db = db;
  if (info.name === 'db' && (w.db ?? parsed.config.defaultDatabase) === MOCK_DB) {
    io.err('mock の疑似 DB は E2E の実行でだけ使えます');
    return 2;
  }
  const timeoutArg = arg(argv, '--timeout');
  const timeout = timeoutArg !== undefined ? Number(timeoutArg) : undefined;
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0)) {
    io.err(`--timeout はミリ秒の整数です: ${timeoutArg}`);
    return 2;
  }
  const stamp = (io.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(io.cwd, arg(argv, '--out') ?? path.join(os.tmpdir(), `ddv-evidence-try-${stamp}`));
  const spec = normalizeSpec({ use: name, with: w, ...(timeout !== undefined ? { timeout } : {}) });
  const capture = io.capture ?? defaultTryCapture;
  const r = await capture({ repoRoot, config: parsed.config, registry, spec, outDir });
  if (r.status === 'failed') {
    io.out(`failed: ${name}（${r.durationMs} ms）— ${r.reason ?? ''}`);
    return 1;
  }
  io.out(`ok: ${name}（${r.durationMs} ms）`);
  for (const f of r.files) io.out(`  ${f.kind}  ${f.path}  ${f.bytes} bytes`);
  io.out(`出力: ${outDir}`);
  return 0;
}

/** `ddv evidence <list | try>`. Returns the exit code. */
export async function evidenceCommand(argv: string[], io: EvidenceIo): Promise<number> {
  const sub = argv[0];
  if (sub !== 'list' && sub !== 'try') {
    io.err(`不明なサブコマンド: evidence ${sub ?? ''}\n\n${io.help ?? EVIDENCE_HELP}`);
    return 2;
  }
  const repoRoot = path.resolve(io.cwd, arg(argv, '--repo') ?? '.');
  if (!existsSync(repoRoot)) {
    io.err(`リポジトリが見つかりません: ${repoRoot}`);
    return 2;
  }
  if (sub === 'list') return list(repoRoot, argv.includes('--json'), io, io.env ?? process.env);
  return tryOne(repoRoot, argv, io);
}
