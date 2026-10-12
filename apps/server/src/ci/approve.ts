import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DdvConfig } from '@ddv/core';
import { loadConfig } from '@ddv/core/node';
import { redact } from '@ddv/github';
import { SnapshotError, SnapshotService, SNAPSHOTS_DIR } from '../snapshots.ts';
import { BOT_ENV, CiGit, gitReason, isPushRejected, type CiGitLike, type GitOutput } from './ci-git.ts';
import { OUTSIDE_ACTIONS, short, type CiEnv } from './ci-run.ts';
import { DEFAULT_RESULTS_BRANCH } from './publish.ts';
import { ResultsBranch } from './results-branch.ts';
import { isRunId, readIndex, readRunRecord, runDir, type Approval } from './results-index.ts';

export interface ApproveOptions {
  repoRoot: string;
  run: string;
  ids?: string[];
  branch?: string;
  request?: string;
  env: CiEnv;
  git?: CiGitLike;
  retries?: number;
  tmpRoot?: string;
  /** Replaced in tests. */
  snapshots?: (repoRoot: string, config: DdvConfig) => Pick<SnapshotService, 'approve'>;
  now?: () => Date;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

class ApproveFailure extends Error {}

const isPng = (n: string) => /^\d{3,}\.png$/.test(n);

/** `ddv ci approve` (DD-ACTWF-APPROVE): commits the run's current images as the baseline to the PR branch. Returns the exit code. */
export async function approve(opts: ApproveOptions): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const error = opts.error ?? ((l: string) => console.error(l));
  const { env } = opts;
  if (!env.runId) {
    error(OUTSIDE_ACTIONS);
    return 2;
  }
  if (!isRunId(opts.run)) {
    error(`--run には結果ブランチの runs の下のディレクトリ名を指定してください: ${opts.run ?? ''}`);
    return 2;
  }
  const repoRoot = path.resolve(opts.repoRoot);
  if (!existsSync(repoRoot)) {
    error(`リポジトリが見つかりません: ${repoRoot}`);
    return 2;
  }
  const git = opts.git ?? new CiGit();
  const tokens = [env.token];
  const run = (args: string[], cwd = repoRoot, extra?: Record<string, string>) => git.run(args, { cwd, env: extra });
  const reason = (o: GitOutput) => redact(gitReason(o.stderr || o.stdout), tokens);
  const resultsBranch = opts.branch ?? DEFAULT_RESULTS_BRANCH;
  const ref = env.ref;
  const fail = (message: string): never => {
    throw new ApproveFailure(message);
  };

  let results: string | null = null;
  try {
    if (env.refType !== 'branch') fail(`基準画像の承認はブランチに対してだけ行えます（${ref}）`);
    const ls = await run(['ls-remote', '--exit-code', '--heads', 'origin', ref]);
    if (ls.code === 2) fail(`ブランチ ${ref} が対象リポジトリにありません（fork の PR は承認できません）`);
    if (ls.code !== 0) fail(`ブランチ ${ref} を確認できませんでした: ${reason(ls)}`);

    const missingRun = `実行 ${opts.run} の結果が結果ブランチにありません（削除済みの可能性）`;
    const f = await run(['fetch', '--no-tags', '--depth', '1', 'origin', `refs/heads/${resultsBranch}`]);
    if (f.code !== 0) fail(missingRun);
    const head = (await run(['rev-parse', 'FETCH_HEAD'])).stdout.trim();
    results = await fs.mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), 'ddv-approve-'));
    const wt = await run(['worktree', 'add', '--detach', results, head]);
    if (wt.code !== 0) fail(`結果ブランチを取得できませんでした: ${reason(wt)}`);
    const runPath = runDir(results, opts.run);
    const rec = await readRunRecord(path.join(runPath, 'run.json'));
    if (!rec || rec.id !== opts.run || !existsSync(path.join(runPath, 'snapshots'))) fail(missingRun);
    const record = rec!;
    const recordedRow = (await readIndex(results)).runs.some((r) => r.id === opts.run);

    const ids = opts.ids?.length ? [...new Set(opts.ids)] : (record.snapshots ?? []).filter((s) => s.steps.some((x) => x.status === 'Diff' || x.status === 'NoBase')).map((s) => s.id);
    if (!ids.length) fail('承認する画像がありません');
    const commitOfRun = record.commit ?? '';
    const retries = opts.retries ?? 3;
    let commit: string | null = null;
    for (let attempt = 0; ; attempt++) {
      const anc = /^[0-9a-f]{7,64}$/i.test(commitOfRun) ? await run(['merge-base', '--is-ancestor', commitOfRun, 'HEAD']) : { code: 1 };
      if (anc.code !== 0) fail(`ブランチ ${ref} が実行のコミット ${short(commitOfRun)} を含みません（force push された可能性）`);
      const missing: string[] = [];
      for (const id of ids) {
        const dir = path.join(runPath, 'snapshots', 'current', id);
        const names = await fs.readdir(dir).catch(() => [] as string[]);
        if (!names.includes('meta.json') || !names.some(isPng)) missing.push(id);
      }
      if (missing.length) fail(`今回の画像がありません: ${missing.join(',')}`);
      for (const id of ids) {
        const dest = path.join(repoRoot, SNAPSHOTS_DIR, 'current', id);
        await fs.rm(dest, { recursive: true, force: true });
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.cp(path.join(runPath, 'snapshots', 'current', id), dest, { recursive: true });
      }
      const config = await loadConfig(repoRoot);
      const service = (opts.snapshots ?? ((root, c) => new SnapshotService(root, () => c)))(repoRoot, config);
      for (const id of ids) {
        try {
          await service.approve(id);
        } catch (e) {
          if (e instanceof SnapshotError) fail(e.message);
          throw e;
        }
      }
      const paths = ids.map((id) => `${SNAPSHOTS_DIR}/baseline/${id}`);
      const st = await run(['status', '--porcelain', '--untracked-files=all', '--', ...paths]);
      if (st.code !== 0) fail(`基準画像の変更を確認できませんでした: ${reason(st)}`);
      if (!st.stdout.trim()) break;
      const add = await run(['add', '-A', '--', ...paths]);
      if (add.code !== 0) fail(`PR のブランチに push できませんでした: ${reason(add)}（保護されたブランチ・権限を確認してください）`);
      const headSha = (await run(['rev-parse', 'HEAD'])).stdout.trim();
      const body = [`run: ${opts.run}`, ...(opts.request ? [`request: ${opts.request}`] : [])];
      if (commitOfRun && !headSha.toLowerCase().startsWith(commitOfRun.toLowerCase())) body.push(`承認した画像はコミット ${short(commitOfRun)} の実行のものです`);
      const c = await run(['commit', '-q', '-m', `ddv: 基準画像を承認（${ids.join(',')}）`, '-m', body.join('\n'), '--', ...paths], repoRoot, BOT_ENV);
      if (c.code !== 0) fail(`PR のブランチに push できませんでした: ${reason(c)}（保護されたブランチ・権限を確認してください）`);
      const push = await run(['push', 'origin', `HEAD:refs/heads/${ref}`]);
      if (push.code === 0) {
        commit = (await run(['rev-parse', 'HEAD'])).stdout.trim();
        break;
      }
      if (!isPushRejected(push.stderr) || attempt >= retries) fail(`PR のブランチに push できませんでした: ${reason(push)}（保護されたブランチ・権限を確認してください）`);
      log(`! PR のブランチへの push が拒否されました。取り直してやり直します（${attempt + 1} 回目）`);
      const fr = await run(['fetch', '--no-tags', 'origin', `refs/heads/${ref}`]);
      if (fr.code !== 0) fail(`PR のブランチに push できませんでした: ${reason(fr)}（保護されたブランチ・権限を確認してください）`);
      await run(['reset', '-q', '--hard', 'FETCH_HEAD']);
    }
    log(commit ? `基準画像を承認しました（${ids.join(',')}）: コミット ${short(commit)}` : `基準画像に変更はありませんでした（${ids.join(',')}）`);

    if (!recordedRow) {
      log(`! 実行 ${opts.run} は結果ブランチの index にないため、承認を記録しません`);
      return 0;
    }
    const approval: Approval = {
      ...(opts.request ? { request: opts.request } : {}),
      actionsRunId: env.runId,
      ids,
      commit,
      at: (opts.now ?? (() => new Date()))().toISOString(),
      ...(env.actor ? { actor: env.actor } : {}),
    };
    const branch = new ResultsBranch({ repoRoot, branch: resultsBranch, git, retries: opts.retries, tmpRoot: opts.tmpRoot, log, tokens });
    try {
      await branch.update(async (_dir, index) => {
        index.runs.find((r) => r.id === opts.run)?.approvals.push(approval);
        return index;
      }, `ddv results: approve ${opts.run}`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      error(commit ? `基準画像はコミットしました（${short(commit)}）が、結果ブランチへの記録に失敗しました: ${why}` : `結果ブランチへの記録に失敗しました: ${why}`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (!(e instanceof ApproveFailure)) throw e;
    error(e.message);
    return 1;
  } finally {
    if (results) {
      await run(['worktree', 'remove', '--force', results]);
      await fs.rm(results, { recursive: true, force: true }).catch(() => {});
      await run(['worktree', 'prune']);
    }
  }
}
