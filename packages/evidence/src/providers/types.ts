// Provider interface shared by the runner and the providers (detailed design evidence-runner.md#構造).
import type { EvidenceHost } from '@ddv/mock';
import type { EvidenceProviderKind } from '@ddv/mock/trace-format';
import type { EvidenceContext } from '../index.ts';
import type { ResolvedArgs } from '../with.ts';

/** Extra fields of the record (db). */
export interface ProviderMeta {
  db?: { name: string; type: string };
  totalRows?: number;
  truncated?: boolean;
  masked?: string[];
}

export interface CaptureResult {
  /** Raw outputs (checked by the runner: one or more, valid shapes). */
  outputs: unknown;
  meta?: ProviderMeta;
}

export interface Provider {
  readonly kind: EvidenceProviderKind;
  readonly timeout?: number;
  capture(args: ResolvedArgs, ctx: EvidenceContext, host: EvidenceHost): Promise<CaptureResult>;
}

const KINDS = ['image', 'table', 'json', 'text', 'file'];

/** `EvidenceOutput` or an array of them, by `kind` and field types (paths are checked by the runner). */
export function isOutputLike(v: unknown): boolean {
  const one = (o: unknown): boolean => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const r = o as Record<string, unknown>;
    if (typeof r.kind !== 'string' || !KINDS.includes(r.kind)) return false;
    if (r.kind === 'image' || r.kind === 'file') return typeof r.path === 'string' && r.path.length > 0;
    if (r.kind === 'text') return typeof r.text === 'string';
    if (r.kind === 'json') return 'data' in r;
    return Array.isArray(r.columns) && Array.isArray(r.rows);
  };
  return Array.isArray(v) ? v.every(one) : one(v);
}
