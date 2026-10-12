import { describe, expect, it } from 'vitest';
import { PagesActionsTarget, pagesActionsTarget, type PagesTargetView } from './pages-actions-target.ts';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const base = (target: PagesTargetView['target'], pr?: PagesTargetView['pr']): PagesTargetView => ({ target, defaultBranch: 'main', commitSha: SHA, pr });

describe('PagesActionsTarget', () => {
  it('PR の対象は head の branch で起動し、PR 番号と headRef を持つ', async () => {
    const t = new PagesActionsTarget(() => base({ owner: 'acme', repo: 'order-app', kind: 'pr', pr: 12 }, { number: 12, headRef: 'feature/confirm-back', headRepo: 'acme/order-app' }));
    expect(await t.resolve()).toEqual({ ref: 'feature/confirm-back', sha: SHA, pr: 12, headRef: 'feature/confirm-back', fork: false });
  });

  it('head のリポジトリが違う PR は fork（大文字小文字を区別しない）', () => {
    expect(pagesActionsTarget(base({ owner: 'acme', repo: 'order-app', kind: 'pr', pr: 3 }, { number: 3, headRef: 'patch-1', headRepo: 'someone/order-app' })).fork).toBe(true);
    expect(pagesActionsTarget(base({ owner: 'Acme', repo: 'Order-App', kind: 'pr', pr: 3 }, { number: 3, headRef: 'patch-1', headRepo: 'acme/order-app' })).fork).toBe(false);
  });

  it('branch の対象はその branch、空なら既定ブランチ。dirty は持たない', () => {
    expect(pagesActionsTarget(base({ owner: 'acme', repo: 'order-app', kind: 'ref', ref: 'develop' }))).toEqual({ ref: 'develop', sha: SHA, fork: false });
    const t = pagesActionsTarget(base({ owner: 'acme', repo: 'order-app', kind: 'ref' }));
    expect(t).toEqual({ ref: 'main', sha: SHA, fork: false });
    expect('dirty' in t).toBe(false);
  });

  it('コミットの対象は detached（起動する branch が無い）', () => {
    expect(pagesActionsTarget(base({ owner: 'acme', repo: 'order-app', kind: 'ref', ref: SHA.slice(0, 7) }))).toEqual({ sha: SHA, fork: false, problem: 'detached' });
  });
});
