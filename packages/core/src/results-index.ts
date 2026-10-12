import { z } from 'zod';

/** `index.json` of the results branch (ddv-results). Written by `ddv ci publish / approve`, read by the viewer. */

export const ApprovalSchema = z.object({
  request: z.string().optional(),
  actionsRunId: z.string(),
  ids: z.array(z.string()),
  /** 承認のコミット。基準画像が変わらなかったときは null */
  commit: z.string().nullable(),
  at: z.string(),
  actor: z.string().optional(),
});

export const ResultsIndexEntrySchema = z.object({
  id: z.string().regex(/^[\w.-]+$/),
  actionsRunId: z.string(),
  request: z.string().optional(),
  commit: z.string(),
  ref: z.string(),
  pr: z.number().int().positive().optional(),
  actor: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(['passed', 'failed', 'error']),
  counts: z.object({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    error: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }),
  /** runs/<id>/traces/ を保持している */
  traces: z.boolean(),
  snapshots: z.object({ diff: z.number().int().min(0), noBase: z.number().int().min(0) }).optional(),
  /** 剪定で run.json だけになった */
  trimmed: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  approvals: z.array(ApprovalSchema).default([]),
});

export const ResultsIndexSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  /** startedAt の新しい順 */
  runs: z.array(ResultsIndexEntrySchema),
});

export type Approval = z.infer<typeof ApprovalSchema>;
export type ResultsIndexEntry = z.infer<typeof ResultsIndexEntrySchema>;
export type ResultsIndexData = z.infer<typeof ResultsIndexSchema>;
