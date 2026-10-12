import { z } from 'zod';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Whether `owner` may be opened by this viewer (OWNERS). Unset `allowedOwners` allows everything. */
export function isOwnerAllowed(owner: string, allowedOwners: readonly string[] | undefined): boolean {
  if (!allowedOwners) return true;
  const o = owner.toLowerCase();
  return allowedOwners.some((a) => a.toLowerCase() === o);
}

export const PagesTargetSchema = z
  .object({
    repo: z.string().regex(REPO, 'owner/repo の形式で書いてください'),
    pr: z.number().int().min(1).optional(),
    ref: z.string().min(1).max(100).optional(),
    label: z.string().max(60).optional(),
  })
  .strict()
  .refine((t) => !(t.pr !== undefined && t.ref !== undefined), 'pr と ref はどちらか一方だけ書いてください');

export const PagesConfigSchema = z
  .object({
    title: z.string().min(1).max(40).default('ddv'),
    defaultTarget: PagesTargetSchema.optional(),
    recentTargets: z.array(PagesTargetSchema).max(20).default([]),
    allowedOwners: z.array(z.string().regex(OWNER)).min(1).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const [i, t] of [c.defaultTarget, ...c.recentTargets].entries()) {
      if (t && !isOwnerAllowed(t.repo.split('/')[0], c.allowedOwners))
        ctx.addIssue({ code: 'custom', path: i === 0 ? ['defaultTarget'] : ['recentTargets', i - 1], message: `allowedOwners に無い owner です: ${t.repo}` });
    }
  });

export type PagesConfig = z.infer<typeof PagesConfigSchema>;
export type PagesTarget = z.infer<typeof PagesTargetSchema>;
