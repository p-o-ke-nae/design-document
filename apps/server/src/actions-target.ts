import { execFile } from 'node:child_process';
import { GitHubError, getBranch, getCommit, listOpenPullsOfHead, type GitHubClient } from '@ddv/github';
import type { ActionsTarget, ActionsTargetProvider, RepoRef } from '@ddv/services';
import { REPO_STATE_TIMEOUT_MS, RepoStateReader, type GitRunner } from './repo-state.ts';
import type { Workspace } from './workspaces.ts';

const defaultGit: GitRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

const notPushed = (e: unknown) => e instanceof GitHubError && (e.kind === 'notFound' || e.kind === 'validation');

/** The local folder: the checked-out branch, its commit / uncommitted changes and the open PR of the branch (actions-run.md「対象の決定」). */
export class LocalActionsTarget implements ActionsTargetProvider {
  constructor(
    private readonly repoRoot: string,
    private readonly repo: RepoRef,
    private readonly client: Pick<GitHubClient, 'rest'>,
    private readonly git: GitRunner = defaultGit,
    private readonly state: RepoStateReader = new RepoStateReader(git),
  ) {}

  async resolve(): Promise<ActionsTarget> {
    const { owner, repo } = this.repo;
    const st = await this.state.read(this.repoRoot);
    let ref: string | undefined;
    try {
      ref = (await this.git(['-C', this.repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], REPO_STATE_TIMEOUT_MS)).trim();
    } catch {
      ref = undefined;
    }
    const sha = st?.commit ?? '';
    const out: ActionsTarget = { sha, fork: false, dirty: st?.dirty ?? false };
    if (!ref || ref === 'HEAD') return { ...out, problem: 'detached' };
    out.ref = ref;
    const pulls = await listOpenPullsOfHead(this.client, owner, repo, `${owner}:${ref}`).catch(() => []);
    const pr = pulls.find((p) => p.head.ref === ref);
    if (pr) {
      out.pr = pr.number;
      out.headRef = ref;
    }
    try {
      await getBranch(this.client, owner, repo, ref);
      if (sha) await getCommit(this.client, owner, repo, sha);
    } catch (e) {
      if (notPushed(e)) out.problem = 'not-pushed';
    }
    return out;
  }
}

/** A GitHub workspace (PR / branch / tag). */
export class WorkspaceActionsTarget implements ActionsTargetProvider {
  constructor(
    private readonly ws: () => Workspace,
    private readonly repo: RepoRef,
  ) {}

  async resolve(): Promise<ActionsTarget> {
    const ws = this.ws();
    const full = `${this.repo.owner}/${this.repo.repo}`.toLowerCase();
    if (ws.target.pr) {
      const headRef = ws.pr?.headRef ?? '';
      const headRepo = ws.pr?.headRepo ?? '';
      return {
        ref: headRef,
        sha: ws.headSha,
        pr: ws.target.pr,
        headRef,
        fork: headRepo !== '' && headRepo.toLowerCase() !== full,
      };
    }
    return { ref: ws.target.ref, sha: ws.headSha, fork: false };
  }
}
