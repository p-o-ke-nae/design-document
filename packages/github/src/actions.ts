import type { GitHubClient } from './client.ts';

/** REST shapes and calls used by the Actions features (actions-run.md). Only the fields ddv reads. */

type Rest = Pick<GitHubClient, 'rest'>;

export interface GhRepo {
  default_branch: string;
  full_name?: string;
  permissions?: { push?: boolean; admin?: boolean; pull?: boolean };
}

export interface GhWorkflowRun {
  id: number;
  run_attempt?: number;
  display_title?: string;
  name?: string;
  head_branch?: string | null;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  html_url: string;
  event?: string;
  actor?: { login: string } | null;
  triggering_actor?: { login: string } | null;
}

export interface GhJobStep {
  number: number;
  name: string;
  status: string;
  conclusion?: string | null;
}

export interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
  steps?: GhJobStep[];
}

export interface GhCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  app?: { slug?: string } | null;
}

export interface DispatchInputs {
  [name: string]: string;
}

const enc = encodeURIComponent;
const encPath = (p: string) => p.split('/').map(enc).join('/');

export function getRepo(gh: Rest, owner: string, repo: string): Promise<GhRepo> {
  return gh.rest<GhRepo>('GET', `/repos/${owner}/${repo}`);
}

/** GET contents of one file at `ref` (throws GitHubError; 404 = missing). */
export function getContent(gh: Rest, owner: string, repo: string, path: string, ref: string): Promise<{ sha: string; path: string }> {
  return gh.rest('GET', `/repos/${owner}/${repo}/contents/${encPath(path)}?ref=${enc(ref)}`);
}

export async function dispatchWorkflow(gh: Rest, owner: string, repo: string, workflow: string, ref: string, inputs: DispatchInputs): Promise<void> {
  await gh.rest('POST', `/repos/${owner}/${repo}/actions/workflows/${enc(workflow)}/dispatches`, { ref, inputs });
}

export async function listWorkflowRuns(gh: Rest, owner: string, repo: string, workflow: string, q: { event?: string; branch?: string; perPage?: number } = {}): Promise<GhWorkflowRun[]> {
  const p = new URLSearchParams();
  if (q.event) p.set('event', q.event);
  if (q.branch) p.set('branch', q.branch);
  p.set('per_page', String(q.perPage ?? 20));
  const r = await gh.rest<{ workflow_runs?: GhWorkflowRun[] }>('GET', `/repos/${owner}/${repo}/actions/workflows/${enc(workflow)}/runs?${p}`);
  return r.workflow_runs ?? [];
}

export function getWorkflowRun(gh: Rest, owner: string, repo: string, runId: string | number): Promise<GhWorkflowRun> {
  return gh.rest<GhWorkflowRun>('GET', `/repos/${owner}/${repo}/actions/runs/${enc(String(runId))}`);
}

export async function listRunJobs(gh: Rest, owner: string, repo: string, runId: string | number): Promise<GhJob[]> {
  const r = await gh.rest<{ jobs?: GhJob[] }>('GET', `/repos/${owner}/${repo}/actions/runs/${enc(String(runId))}/jobs?per_page=100`);
  return r.jobs ?? [];
}

export async function listCheckRuns(gh: Rest, owner: string, repo: string, sha: string): Promise<GhCheckRun[]> {
  const r = await gh.rest<{ check_runs?: GhCheckRun[] }>('GET', `/repos/${owner}/${repo}/commits/${enc(sha)}/check-runs?per_page=100`);
  return r.check_runs ?? [];
}

export function getBranch(gh: Rest, owner: string, repo: string, branch: string): Promise<{ name: string; commit: { sha: string } }> {
  return gh.rest('GET', `/repos/${owner}/${repo}/branches/${encPath(branch)}`);
}

export function getCommit(gh: Rest, owner: string, repo: string, sha: string): Promise<{ sha: string }> {
  return gh.rest('GET', `/repos/${owner}/${repo}/commits/${enc(sha)}`);
}

/** `object.sha` of `refs/heads/<branch>` (GitHubError notFound when the branch does not exist). */
export async function getBranchRef(gh: Rest, owner: string, repo: string, branch: string): Promise<string> {
  const r = await gh.rest<{ object: { sha: string } }>('GET', `/repos/${owner}/${repo}/git/ref/heads/${encPath(branch)}`);
  return r.object.sha;
}

export async function listOpenPullsOfHead(gh: Rest, owner: string, repo: string, head: string): Promise<Array<{ number: number; head: { ref: string } }>> {
  return gh.rest('GET', `/repos/${owner}/${repo}/pulls?head=${enc(head)}&state=open&per_page=1`);
}
