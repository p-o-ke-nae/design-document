// Result keys per platform (platform-results.md「結果のキー」「集計」). Browser-safe.
import { PLATFORMS, type Platform } from '@ddv/mock/browser';
import type { CaseResult } from './history.ts';

export type { Platform };

export interface ParsedKey {
  testId: string;
  platform: Platform;
}

/** `testId` for web / no platform, otherwise `<testId>@<platform>`. */
export function resultKey(testId: string, platform?: Platform | null): string {
  return !platform || platform === 'web' ? testId : `${testId}@${platform}`;
}

/** Splits a result key: only a `wpf` / `winforms` suffix after the last `@` is a platform; anything else is a plain (web) key (DD-PLATRES-RKEY). */
export function parseResultKey(key: string): ParsedKey {
  const at = key.lastIndexOf('@');
  if (at < 0) return { testId: key, platform: 'web' };
  const suffix = key.slice(at + 1);
  if (suffix === 'wpf' || suffix === 'winforms') return { testId: key.slice(0, at), platform: suffix };
  return { testId: key, platform: 'web' };
}

/** Platforms in display order (web, wpf, winforms), unique. Unknown values are dropped. */
export function sortPlatforms(list: Iterable<string>): Platform[] {
  const set = new Set<string>(list);
  return PLATFORMS.filter((p) => set.has(p));
}

export const PlatformResults = {
  /** Latest results grouped by test id: test id → platform → result. */
  byTest<R extends Pick<CaseResult, 'status'>>(latest: Record<string, R>): Map<string, Partial<Record<Platform, R>>> {
    const out = new Map<string, Partial<Record<Platform, R>>>();
    for (const [key, res] of Object.entries(latest)) {
      const { testId, platform } = parseResultKey(key);
      let rec = out.get(testId);
      if (!rec) out.set(testId, (rec = {}));
      rec[platform] = res;
    }
    return out;
  },

  /**
   * One result for coverage (DD-PLATRES-COVMERGE): none → null; any failed / error → that (first, in platform order) failure;
   * all passed → passed; otherwise skipped.
   */
  combine<R extends Pick<CaseResult, 'status' | 'message'>>(results: Partial<Record<Platform, R>> | undefined | null): R | null {
    const list = PLATFORMS.map((p) => results?.[p]).filter((r): r is R => !!r);
    if (!list.length) return null;
    const fail = list.find((r) => r.status === 'failed' || r.status === 'error');
    if (fail) return fail;
    if (list.every((r) => r.status === 'passed')) return list[0];
    return list.find((r) => r.status === 'skipped') ?? list[0];
  },
};
