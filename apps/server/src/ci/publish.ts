import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { CiGitLike } from './ci-git.ts';
import { OUTSIDE_ACTIONS, short, type CiEnv } from './ci-run.ts';
import { ResultsBranch, ResultsBranchError } from './results-branch.ts';
import { entryFromRecord, isHeavy, readRunRecord, runDir, runDirs, type CiRunRecord } from './results-index.ts';
import { planResults, type ResultsLimits, type ResultsPrunePlan } from './results-prune.ts';

export const DEFAULT_RESULTS_BRANCH = 'ddv-results';
export const DEFAULT_LIMITS: ResultsLimits = { maxRuns: 200, maxDays: 90, maxTraceRuns: 20 };

export interface PublishOptions {
  repoRoot: string;
  out: string;
  branch?: string;
  limits?: ResultsLimits;
  env: CiEnv;
  git?: CiGitLike;
  fetch?: typeof fetch;
  now?: () => Date;
  retries?: number;
  tmpRoot?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** The PR of the run: the first open PR containing `commit` whose head branch is `ref`. Failures are ignored. */
export async function findPullRequest(env: CiEnv, commit: string, ref: string, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  if (!env.repository || !/^[0-9a-f]{7,64}$/i.test(commit) || !ref) return undefined;
  try {
    const res = await fetchImpl(`${env.apiUrl.replace(/\/$/, '')}/repos/${env.repository}/commits/${commit}/pulls`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(env.token ? { authorization: `Bearer ${env.token}` } : {}) },
    });
    if (!res.ok) return undefined;
    const list = (await res.json()) as Array<{ number?: unknown; state?: unknown; head?: { ref?: unknown } }>;
    if (!Array.isArray(list)) return undefined;
    const pr = list.find((p) => p?.state === 'open' && p.head?.ref === ref);
    return typeof pr?.number === 'number' && pr.number > 0 ? pr.number : undefined;
  } catch {
    return undefined;
  }
}

/** Copies `out` into `runs/<id>/`, updates the index row and prunes (ResultsBranch edit of `ddv ci publish`). */
export async function applyPublish(dir: string, out: string, rec: CiRunRecord, index: Parameters<typeof planResults>[0], limits: ResultsLimits, now: Date, extras: { pr?: number; actor?: string }): Promise<ResultsPrunePlan> {
  const target = runDir(dir, rec.id);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  await fs.copyFile(path.join(out, 'run.json'), path.join(target, 'run.json'));
  for (const sub of ['traces', 'snapshots']) if (existsSync(path.join(out, sub))) await fs.cp(path.join(out, sub), path.join(target, sub), { recursive: true });
  const traces = existsSync(path.join(target, 'traces')) && (await fs.readdir(path.join(target, 'traces'))).length > 0;
  index.runs = index.runs.filter((r) => r.id !== rec.id);
  index.runs.push(entryFromRecord(rec, { traces, ...extras }));
  const ids = await runDirs(dir);
  const heavy: string[] = [];
  const orphan: string[] = [];
  for (const id of ids) {
    if (!existsSync(path.join(runDir(dir, id), 'run.json'))) orphan.push(id);
    else if (await isHeavy(dir, id)) heavy.push(id);
  }
  const plan = planResults(index, heavy, orphan, limits, now);
  for (const id of plan.runs) await fs.rm(runDir(dir, id), { recursive: true, force: true });
  for (const id of plan.trim) {
    await fs.rm(path.join(runDir(dir, id), 'traces'), { recursive: true, force: true });
    await fs.rm(path.join(runDir(dir, id), 'snapshots'), { recursive: true, force: true });
    const row = index.runs.find((r) => r.id === id);
    if (row) Object.assign(row, { traces: false, trimmed: true });
  }
  const gone = new Set(plan.runs);
  index.runs = index.runs.filter((r) => !gone.has(r.id));
  return plan;
}

/** `ddv ci publish`: saves the output of `ddv ci run` to the results branch. Returns the exit code. */
export async function publish(opts: PublishOptions): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const error = opts.error ?? ((l: string) => console.error(l));
  if (!opts.env.runId) {
    error(OUTSIDE_ACTIONS);
    return 2;
  }
  const runJson = path.join(path.resolve(opts.out), 'run.json');
  const rec = await readRunRecord(runJson);
  if (!rec) {
    error(`run.json がありません: ${runJson}`);
    return 1;
  }
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const now = (opts.now ?? (() => new Date()))();
  const pr = await findPullRequest(opts.env, rec.commit ?? '', rec.ref ?? opts.env.ref, opts.fetch);
  const branch = new ResultsBranch({
    repoRoot: path.resolve(opts.repoRoot),
    branch: opts.branch ?? DEFAULT_RESULTS_BRANCH,
    git: opts.git,
    retries: opts.retries,
    tmpRoot: opts.tmpRoot,
    log,
    tokens: [opts.env.token],
  });
  let plan: ResultsPrunePlan = { runs: [], trim: [] };
  try {
    const r = await branch.update(async (dir, index) => {
      plan = await applyPublish(dir, path.resolve(opts.out), rec, index, limits, now, { pr, actor: opts.env.actor || undefined });
      return index;
    }, `ddv results: ${rec.id}`);
    log(`結果ブランチ ${branch.branch} に保存しました: runs/${rec.id}（コミット ${short(r.commit)}、削除 ${plan.runs.length} 件、詳細の削除 ${plan.trim.length} 件）`);
    return 0;
  } catch (e) {
    if (e instanceof ResultsBranchError && e.code === 'conflict') error(e.message);
    else error(`結果ブランチへ保存できませんでした: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}
