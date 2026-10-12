/** Recently opened targets (pages-viewer.md「最近開いた対象」): `localStorage` `ddv.pages.recent`. No PAT, SHA or PR body (REQ-608). */
import { z } from 'zod';
import { isOwnerAllowed } from '@ddv/core';
import { targetKey, type HostedTarget } from './hash-route.ts';

export const RECENT_KEY = 'ddv.pages.recent';
export const RECENT_MAX = 10;

const RecentTargetSchema = z.object({
  repo: z.string(),
  kind: z.enum(['pr', 'ref']),
  pr: z.number().int().min(1).optional(),
  ref: z.string().optional(),
  label: z.string().max(200),
  openedAt: z.string(),
});
const RecentListSchema = z.array(RecentTargetSchema).max(RECENT_MAX);

export type RecentTarget = z.infer<typeof RecentTargetSchema>;

export function recentToTarget(r: RecentTarget): HostedTarget {
  const [owner = '', repo = ''] = r.repo.split('/');
  return { owner, repo, kind: r.kind, ...(r.kind === 'pr' && r.pr ? { pr: r.pr } : {}), ...(r.kind === 'ref' && r.ref ? { ref: r.ref } : {}) };
}

export class RecentTargets {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null,
    private readonly allowedOwners?: readonly string[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  private read(): RecentTarget[] {
    try {
      const text = this.storage?.getItem(RECENT_KEY);
      if (!text) return [];
      const r = RecentListSchema.safeParse(JSON.parse(text));
      return r.success ? r.data : [];
    } catch {
      return [];
    }
  }

  list(): RecentTarget[] {
    return this.read().filter((r) => isOwnerAllowed(r.repo.split('/')[0] ?? '', this.allowedOwners));
  }

  add(target: HostedTarget, label: string): void {
    const key = targetKey(target);
    const entry: RecentTarget = {
      repo: `${target.owner}/${target.repo}`,
      kind: target.kind,
      ...(target.kind === 'pr' && target.pr ? { pr: target.pr } : {}),
      ...(target.kind === 'ref' && target.ref ? { ref: target.ref } : {}),
      label: label.slice(0, 200),
      openedAt: this.now().toISOString(),
    };
    const list = [entry, ...this.read().filter((r) => targetKey(recentToTarget(r)) !== key)].slice(0, RECENT_MAX);
    try {
      this.storage?.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {
      // Storage full or disabled: the list is a convenience only.
    }
  }
}
