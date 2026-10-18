// Public entry of @ddv/evidence (browser-safe parts and the types used by e2e/ddv-hooks.ts).
// Node-only parts: `@ddv/evidence/registry`・`/hooks-scan`・`/check`・`/cli`.
import type { DesktopApp, Platform } from '@ddv/mock';
import type { ParamDef } from './config.ts';
import type { EvidenceAt, Scalar } from './spec.ts';
import type { ResolvedArgs } from './with.ts';

export * from './spec.ts';
export * from './with.ts';
export * from './config.ts';
export * from './sql-guard.ts';

export type Cell = string | number | boolean | null;

/** What a provider returns (also the return value of hooks' functions). `path` is a file inside `ctx.outDir`. */
export type EvidenceOutput =
  | { kind: 'image'; path: string }
  | { kind: 'table'; columns: string[]; rows: Cell[][] }
  | { kind: 'json'; data: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string };

/** Context passed to providers and hooks' functions (evidence-runner.md#構造). */
export interface EvidenceContext {
  platform: Platform;
  testId: string;
  step: number;
  at: EvidenceAt;
  outDir: string;
  input: Record<string, Scalar>;
  signal: AbortSignal;
  /** Playwright `Page` (web). */
  page?: unknown;
  /** Desktop app (wpf / winforms). */
  app?: DesktopApp;
}

export interface EvidenceDefinition<A extends ResolvedArgs = ResolvedArgs> {
  params: Record<string, Partial<ParamDef>>;
  timeout?: number;
  run(args: A, ctx: EvidenceContext): Promise<EvidenceOutput | EvidenceOutput[]> | EvidenceOutput | EvidenceOutput[];
}

/** `export const evidence: EvidenceHooks = { ... }` in e2e/ddv-hooks.ts. */
export type EvidenceHooks = Record<string, EvidenceDefinition>;

/** Returns `def` as is (for typing hooks' evidence functions; also the marker read by `scanEvidenceHooks`). */
export function defineEvidence<A extends ResolvedArgs = ResolvedArgs>(def: EvidenceDefinition<A>): EvidenceDefinition<A> {
  return def;
}
