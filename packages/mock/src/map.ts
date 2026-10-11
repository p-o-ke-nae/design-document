import { z } from 'zod';

export const ScreenRuleSchema = z
  .strictObject({
    /** Regular expression matched against the URL path. */
    url: z.string().optional(),
    selector: z.string().optional(),
  })
  .refine((r) => r.url !== undefined || r.selector !== undefined, { message: 'url か selector のどちらかが必要です' });

/** `scenarios/_map.yaml`: maps scenario keys to the real application. */
export const ScreenMapSchema = z.strictObject({
  screens: z.record(z.string(), ScreenRuleSchema).default({}),
  events: z.record(z.string(), z.string()).default({}),
  fields: z.record(z.string(), z.string()).default({}),
});

export type ScreenRule = z.infer<typeof ScreenRuleSchema>;
export type ScreenMap = z.infer<typeof ScreenMapSchema>;

export const SCREEN_MAP_FILE = '_map.yaml';
