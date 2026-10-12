/** Pending reviews of the Pages edition (pages-viewer.md「保留中レビュー」): IndexedDB `reviews`, key `owner/repo#N`. */
import type { PendingReview, PendingReviewStore } from '@ddv/services';
import type { ReviewDb } from './hosted-db.ts';

export const PAGES_CHANNEL = 'ddv-pages';
export const NO_DB_WARNING = 'この端末に保存できません';

export interface ReviewsChanged {
  type: 'reviews-changed';
  key: string;
}

export const reviewKey = (owner: string, repo: string, pr: number) => `${owner}/${repo}#${pr}`;

function normalize(v: unknown): PendingReview {
  const d = (v && typeof v === 'object' ? v : {}) as Partial<PendingReview>;
  return {
    headSha: typeof d.headSha === 'string' ? d.headSha : '',
    ...(typeof d.mergeBase === 'string' && d.mergeBase ? { mergeBase: d.mergeBase } : {}),
    comments: Array.isArray(d.comments) ? d.comments : [],
  };
}

export class IdbPendingStore implements PendingReviewStore {
  /** Kept for the tab when IndexedDB is not available (the UI shows `NO_DB_WARNING`). */
  private readonly memory = new Map<string, PendingReview>();

  constructor(
    private readonly db: ReviewDb | null,
    private readonly channel: Pick<BroadcastChannel, 'postMessage'> | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get persistent(): boolean {
    return this.db !== null;
  }

  async read(owner: string, repo: string, pr: number): Promise<PendingReview> {
    const key = reviewKey(owner, repo, pr);
    if (!this.db) return normalize(this.memory.get(key));
    try {
      return normalize(await this.db.get(key));
    } catch {
      return normalize(undefined);
    }
  }

  async write(owner: string, repo: string, pr: number, review: PendingReview): Promise<void> {
    const key = reviewKey(owner, repo, pr);
    if (!this.db) this.memory.set(key, structuredClone(review));
    else await this.db.put(key, structuredClone(review), this.now().toISOString());
    this.channel?.postMessage({ type: 'reviews-changed', key } satisfies ReviewsChanged);
  }
}
