import type { ActionsTarget, ActionsTargetProvider, PullInfo } from '@ddv/services';

/** What `PagesActionsTarget` reads of `TargetSnapshot` (pages-viewer.md). */
export interface PagesTargetView {
  target: { owner: string; repo: string; kind: 'pr' | 'ref'; pr?: number; ref?: string };
  defaultBranch: string;
  commitSha: string;
  pr?: Pick<PullInfo, 'number' | 'headRef' | 'headRepo'>;
}

const COMMIT = /^[0-9a-f]{7,40}$/i;

/** Pages edition's `ActionsTargetProvider` (services.md「PagesActionsTarget」; same rules as the server's `WorkspaceActionsTarget`). */
export class PagesActionsTarget implements ActionsTargetProvider {
  constructor(private readonly snapshot: () => PagesTargetView) {}

  async resolve(): Promise<ActionsTarget> {
    return pagesActionsTarget(this.snapshot());
  }
}

export function pagesActionsTarget(s: PagesTargetView): ActionsTarget {
  const { target } = s;
  if (target.kind === 'pr') {
    const headRef = s.pr?.headRef ?? '';
    const headRepo = s.pr?.headRepo ?? '';
    const full = `${target.owner}/${target.repo}`.toLowerCase();
    return { ref: headRef, sha: s.commitSha, pr: target.pr ?? s.pr?.number, headRef, fork: headRepo !== '' && headRepo.toLowerCase() !== full };
  }
  const ref = target.ref || s.defaultBranch;
  // A commit target has no branch to dispatch the workflow on.
  if (COMMIT.test(ref) && s.commitSha.toLowerCase().startsWith(ref.toLowerCase())) return { sha: s.commitSha, fork: false, problem: 'detached' };
  return { ref, sha: s.commitSha, fork: false };
}
