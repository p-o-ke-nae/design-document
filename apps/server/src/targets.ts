// Targets of the scenarios and the check of a run request (platform-results.md「接続先の一覧」「開始の要求」).
import type { DdvConfig, RunnerConfig } from '@ddv/core';
import { DesktopGate, type GateResult, type RunnerGate } from '@ddv/desktop';
import { linksScenarios } from '@ddv/testid';
import type { RunRequest } from './runs.ts';

export type { RunnerGate };

export type TargetPlatform = 'web' | 'wpf' | 'winforms';

export interface Target {
  name: string;
  platform: TargetPlatform;
  /** playwright: base URL or「モック（<mocksRoot>）」; flaui: `app.path`. */
  target: string;
  available: boolean;
  code?: string;
  reason?: string;
}

export interface RunRequestError {
  status: 400 | 409;
  code: string;
  error: string;
}

/** Target runners (scenario-linked playwright runners and flaui runners), in config order. */
export function targetRunners(config: DdvConfig): RunnerConfig[] {
  return config.runners.filter(linksScenarios);
}

/** `GET /api/tests/targets`. */
export async function listTargets(config: DdvConfig, gate: RunnerGate, env: Record<string, string | undefined> = process.env): Promise<Target[]> {
  const out: Target[] = [];
  for (const r of targetRunners(config)) {
    const platform: TargetPlatform = r.platform ?? 'web';
    const target = r.type === 'flaui' ? (r.app?.path ?? '') : env.DDV_BASE_URL || `モック（${config.mocksRoot}）`;
    const g = await gate.evaluate(r);
    out.push({ name: r.name, platform, target, available: g.available, ...(g.code ? { code: g.code } : {}), ...(g.reason ? { reason: g.reason } : {}) });
  }
  return out;
}

/** Checks `runner` / `runners` of a run request (DD-PLATRES-RUNREQ); null = start (or the request has no `runners`). */
export async function validateRunRequest(request: RunRequest, targets: () => Promise<Target[]>): Promise<RunRequestError | null> {
  if (request.runner !== undefined && request.runners !== undefined) return { status: 400, code: 'bad-request', error: 'runner と runners は同時に指定できません' };
  if (request.runners === undefined) return null;
  if (!Array.isArray(request.runners) || !request.runners.length) return { status: 400, code: 'no-target', error: '接続先を選んでください' };
  const list = await targets();
  const byName = new Map(list.map((t) => [t.name, t]));
  const unknown = request.runners.find((n) => !byName.has(n));
  if (unknown !== undefined) return { status: 400, code: 'unknown-target', error: `接続先がありません: ${unknown}` };
  const chosen = [...new Set(request.runners)].map((n) => byName.get(n)!);
  const platforms = chosen.map((t) => t.platform);
  if (new Set(platforms).size !== platforms.length) return { status: 400, code: 'platform-duplicate', error: '同じプラットフォームの接続先は 1 回の実行で 1 つまでです' };
  const bad = chosen.find((t) => !t.available);
  if (bad) return { status: 409, code: 'target-unavailable', error: `${bad.name} は使えません: ${bad.reason ?? ''}` };
  return null;
}

/**
 * The server's gate. `DDV_DESKTOP_GATE` (JSON: runner name → `{ available, code?, reason? }`) replaces the judgement
 * of the listed runners (E2E); the others use `fallback`.
 */
export function gateFromEnv(value: string | undefined, fallback: RunnerGate): RunnerGate {
  if (!value) return fallback;
  let fixed: Record<string, GateResult>;
  try {
    fixed = JSON.parse(value) as Record<string, GateResult>;
  } catch {
    console.warn('[ddv] DDV_DESKTOP_GATE を JSON として読めません（無視します）');
    return fallback;
  }
  return { evaluate: async (r) => (Object.hasOwn(fixed, r.name) ? { ...fixed[r.name] } : fallback.evaluate(r)) };
}

/** Default gate of a repository (env override, then `DesktopGate`). */
export function serverGate(repoRoot: string, env: Record<string, string | undefined> = process.env): RunnerGate {
  return gateFromEnv(env.DDV_DESKTOP_GATE, new DesktopGate({ repoRoot }));
}
