import { existsSync } from 'node:fs';
import path from 'node:path';
import { approve } from './approve.ts';
import { CiGit, type CiGitLike } from './ci-git.ts';
import { ciEnvFrom, CiRun, parseIds, type CiEnv } from './ci-run.ts';
import { DEFAULT_LIMITS, DEFAULT_RESULTS_BRANCH, publish } from './publish.ts';
import type { ResultsLimits } from './results-prune.ts';
import { initWorkflow, TemplateMissingError } from './workflow-init.ts';

export const CI_HELP = `  ddv actions init [--repo <path>] [--force]
      ddv ワークフロー（.github/workflows/ddv-tests.yml）を配置します（既存と違えば差分を表示して終了コード 1、--force で上書き）
  ddv ci run [--repo <path>] [--ids <id,...>] [--runner <name>] [--out <dir>] [--request <依頼ID>] [--sha <sha>]
      ddv ワークフローの中で、ランナー・スナップショットを実行し、実行記録・トレース・スナップショットを --out に出力します
  ddv ci publish --out <dir> [--repo <path>] [--branch ddv-results] [--max-runs 200] [--max-days 90] [--max-trace-runs 20]
      --out の結果を結果ブランチに保存し、古い結果を削除します
  ddv ci approve --run <実行ID> [--ids <id,...>] [--repo <path>] [--branch ddv-results] [--request <依頼ID>]
      結果ブランチの今回の画像を基準画像として PR のブランチにコミットします
`;

export interface CiCommandDeps {
  env?: CiEnv;
  git?: CiGitLike;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Full HELP printed after an unknown sub-command. */
  help?: string;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `ddv actions …` / `ddv ci …`: parses the arguments and returns the exit code. */
export class CiCommand {
  private log: (line: string) => void;
  private error: (line: string) => void;

  constructor(private deps: CiCommandDeps = {}) {
    this.log = deps.log ?? ((l) => console.log(l));
    this.error = deps.error ?? ((l) => console.error(l));
  }

  private get env() {
    return this.deps.env ?? ciEnvFrom();
  }

  private repo(argv: string[]) {
    return path.resolve(arg(argv, '--repo') || process.cwd());
  }

  private unknown(sub: string) {
    this.error(`不明なサブコマンド: ${sub}\n\n${this.deps.help ?? CI_HELP}`);
    return 2;
  }

  /** argv after `actions` / `ci`, prefixed by the group: `['actions', 'init', …]`. */
  async main(argv: string[]): Promise<number> {
    const [group, sub, ...rest] = argv;
    if (group === 'actions') return sub === 'init' ? this.actionsInit(rest) : this.unknown(`actions ${sub ?? ''}`);
    if (group === 'ci') {
      if (sub === 'run') return this.ciRun(rest);
      if (sub === 'publish') return this.ciPublish(rest);
      if (sub === 'approve') return this.ciApprove(rest);
      return this.unknown(`ci ${sub ?? ''}`);
    }
    return this.unknown(group ?? '');
  }

  private async actionsInit(argv: string[]): Promise<number> {
    const repo = this.repo(argv);
    if (!existsSync(repo)) {
      this.error(`リポジトリが見つかりません: ${repo}`);
      return 2;
    }
    try {
      const r = await initWorkflow(repo, { force: argv.includes('--force'), git: this.deps.git });
      if (r.status === 'created') this.log(`配置しました: ${r.path}（コミットして既定ブランチへマージしてください）`);
      else if (r.status === 'unchanged') this.log(`変更なし: ${r.path}`);
      else if (r.status === 'overwritten') this.log(`上書きしました: ${r.path}`);
      else {
        this.log(r.diff ?? '');
        this.error('既存のファイルと内容が異なります。上書きするには --force を付けてください');
        return 1;
      }
      return 0;
    } catch (e) {
      if (!(e instanceof TemplateMissingError)) throw e;
      this.error(e.message);
      return 1;
    }
  }

  private async ciRun(argv: string[]): Promise<number> {
    const r = await new CiRun({
      repoRoot: this.repo(argv),
      out: arg(argv, '--out') || undefined,
      ids: parseIds(arg(argv, '--ids')),
      runner: arg(argv, '--runner') || undefined,
      request: arg(argv, '--request') || undefined,
      sha: arg(argv, '--sha') || undefined,
      env: this.env,
      log: this.log,
      error: this.error,
    }).run();
    return r.exitCode;
  }

  private async checkBranch(argv: string[]): Promise<string | null> {
    const branch = arg(argv, '--branch') || DEFAULT_RESULTS_BRANCH;
    const r = await (this.deps.git ?? new CiGit()).run(['check-ref-format', '--branch', branch], { cwd: process.cwd() });
    if (r.code !== 0) {
      this.error(`--branch がブランチ名として正しくありません: ${branch}`);
      return null;
    }
    return branch;
  }

  private async ciPublish(argv: string[]): Promise<number> {
    const out = arg(argv, '--out');
    if (!out) {
      this.error('--out を指定してください');
      return 2;
    }
    const limits: ResultsLimits = { ...DEFAULT_LIMITS };
    const names = [
      ['--max-runs', 'maxRuns'],
      ['--max-days', 'maxDays'],
      ['--max-trace-runs', 'maxTraceRuns'],
    ] as const;
    for (const [flag, key] of names) {
      const v = arg(argv, flag);
      if (v === undefined) continue;
      if (!/^\d+$/.test(v.trim())) {
        this.error(`${flag} は 0 以上の整数です`);
        return 2;
      }
      limits[key] = Number(v.trim());
    }
    const branch = await this.checkBranch(argv);
    if (!branch) return 2;
    return publish({ repoRoot: this.repo(argv), out, branch, limits, env: this.env, git: this.deps.git, fetch: this.deps.fetch, log: this.log, error: this.error });
  }

  private async ciApprove(argv: string[]): Promise<number> {
    const runId = arg(argv, '--run');
    if (!runId) {
      this.error('--run を指定してください');
      return 2;
    }
    const branch = await this.checkBranch(argv);
    if (!branch) return 2;
    return approve({
      repoRoot: this.repo(argv),
      run: runId,
      ids: parseIds(arg(argv, '--ids')),
      branch,
      request: arg(argv, '--request') || undefined,
      env: this.env,
      git: this.deps.git,
      log: this.log,
      error: this.error,
    });
  }
}
