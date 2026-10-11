#!/usr/bin/env node
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { loadConfig } from '@ddv/core/node';
import { GitHubClient, TokenResolver } from '@ddv/github';
import { initMocks, scaffoldMock } from '@ddv/mock';
import { createContext } from './app.ts';
import { GitCache } from './git.ts';
import { devOriginsFromEnv } from './guard.ts';
import { createServerApp } from './host.ts';
import { SnapshotService } from './snapshots.ts';
import { cleanWorkspaces, OpenRequestError, parseOpenRequest, WorkspaceManager } from './workspaces.ts';

const HELP = `ddv - Design Doc Viewer

使い方:
  ddv serve [--repo <path>] [--port <n>] [--host 127.0.0.1] [--dev-origin <url>]
      ローカルリポジトリを閲覧するサーバを起動します（既定: カレント, 5178）
      apps/web/dist が無い場合は API のみ提供します（開発時は npm run dev:web）
      --dev-origin: 変更系 API を許可する追加の Origin（vite 開発サーバ。環境変数 DDV_DEV_ORIGIN でも可）
  ddv serve [--repo <path>] --github <owner/repo> (--pr <n> | --ref <name>)
      起動時に GitHub の PR・branch・tag をワークスペースとして開きます（--repo 省略時は手元のワークスペース無し）
      認証: gh auth token → 環境変数 GITHUB_TOKEN
  ddv gh clean [--repo <owner/repo>]
      閉じたワークスペースの worktree を削除します（--repo 指定時は使われていない clone も削除）
  ddv mock scaffold [--repo <path>] [--mock <name>]
      画面遷移図の経路（P）ごとにシナリオの骨組みを生成・マージします（ddv-testid generate の後に実行）
  ddv mock init [--repo <path>]
      モックの runtime（<mocksRoot>/_ddv/mock-runtime.js）と固定の spec（e2e/ddv-scenarios.spec.ts）を配置します
  ddv mock snapshot [--repo <path>] [--id <ID>] [--approve]
      シナリオを再生して各ステップの画面を撮影し、基準画像と比較します（--id 省略時は全シナリオ）
      --approve: 今回の撮影結果を基準として承認します（.ddv/snapshots/baseline/ へコピー）
      ブラウザは mock.browser.channel（環境変数 DDV_BROWSER_CHANNEL で上書き可）

環境変数:
  DDV_HOME          キャッシュ・ワークスペースの置き場所（既定: ~/.ddv）
  DDV_GITHUB_POLL   PR の更新検知の間隔（秒。既定 60、0 で無効）

関連コマンド:
  ddv-testid generate|list|check|show   テストIDの採番・確認
  ddv-lint                              ドキュメント検査
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function initCommand(repo: string) {
  const r = await initMocks(repo, await loadConfig(repo));
  const word = { created: '作成', updated: '更新', unchanged: '変更なし' } as const;
  console.log(`runtime: ${word[r.runtime]}（${r.runtimePath}）、spec: ${word[r.spec]}（${r.specPath}）`);
}

async function snapshotCommand(repo: string, argv: string[]) {
  const config = await loadConfig(repo);
  const service = new SnapshotService(repo, () => config);
  const id = arg(argv, '--id');
  if (argv.includes('--approve')) {
    const ids = id ? [id] : (await fs.readdir(path.join(service.store.root, 'current')).catch(() => [] as string[])).sort();
    if (!ids.length) {
      console.error('承認できる撮影結果がありません（先に ddv mock snapshot を実行してください）');
      process.exitCode = 1;
      return;
    }
    for (const x of ids) {
      try {
        const r = await service.approve(x);
        console.log(`${x}: ステップ ${r.approved.join(', ')} を承認しました`);
      } catch (e) {
        console.error(`! ${x}: ${e instanceof Error ? e.message : e}`);
        process.exitCode = 1;
      }
    }
    return;
  }
  const summary = await service.capture(id ? [id] : undefined, { log: (l) => console.log(l), event: () => {} });
  const counts: Record<string, number> = {};
  for (const s of summary.scenarios) for (const st of s.steps) counts[st.status] = (counts[st.status] ?? 0) + 1;
  console.log(`シナリオ: ${summary.scenarios.length}、一致: ${counts.Match ?? 0}、差分あり: ${counts.Diff ?? 0}、基準なし: ${counts.NoBase ?? 0}、失敗: ${summary.scenarios.filter((s) => s.status !== 'passed').length}`);
  if (summary.status !== 'passed') process.exitCode = 1;
}

async function mockCommand(argv: string[]) {
  const sub = argv[0];
  if (sub !== 'scaffold' && sub !== 'snapshot' && sub !== 'init') {
    console.error(`不明なサブコマンド: mock ${sub ?? ''}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  const repo = path.resolve(arg(argv, '--repo') ?? process.cwd());
  if (!existsSync(repo)) throw new Error(`リポジトリが見つかりません: ${repo}`);
  if (sub === 'snapshot') return snapshotCommand(repo, argv);
  if (sub === 'init') return initCommand(repo);
  const r = await scaffoldMock(repo, await loadConfig(repo), arg(argv, '--mock'));
  for (const w of r.warnings) console.warn(`! ${w}`);
  for (const s of r.skipped) console.warn(`! 形式が不正なため更新しませんでした: ${s}`);
  console.log(`対象モック: ${r.mocks.join(', ') || 'なし'}`);
  console.log(`追加: ${r.added}、更新: ${r.updated}、欠番: ${r.retired}、変更なし: ${r.unchanged}、要確認: ${r.todo}`);
}

function ddvHome(): string {
  return path.resolve(process.env.DDV_HOME || path.join(os.homedir(), '.ddv'));
}

/** GitHub access. DDV_GITHUB_API / DDV_GITHUB_GIT_URL ({owner}, {repo}) / DDV_GITHUB_NO_GH=1 point it at a test double. */
function githubDeps(home: string) {
  const apiBase = process.env.DDV_GITHUB_API || undefined;
  const tokens = new TokenResolver({ apiBase, ...(process.env.DDV_GITHUB_NO_GH === '1' ? { runGh: async () => null } : {}) });
  const github = new GitHubClient(tokens, { apiBase });
  const tpl = process.env.DDV_GITHUB_GIT_URL;
  const git = new GitCache(home, tokens, tpl ? { remoteUrl: (o, r) => tpl.replaceAll('{owner}', o).replaceAll('{repo}', r) } : {});
  return { tokens, github, git };
}

async function ghCommand(argv: string[]) {
  if (argv[0] !== 'clean') {
    console.error(`不明なサブコマンド: gh ${argv[0] ?? ''}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  const home = ddvHome();
  const r = await cleanWorkspaces(home, githubDeps(home).git, arg(argv, '--repo'));
  for (const d of r.worktrees) console.log(`削除: ${d}`);
  for (const d of r.clones) console.log(`削除: ${d}`);
  for (const d of r.kept) console.log(`残しました（開いているワークスペースが使用中）: ${d}`);
  if (!r.worktrees.length && !r.clones.length) console.log('削除するものはありません');
}

async function main(argv: string[]) {
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(HELP);
    return;
  }
  if (cmd === 'mock') {
    await mockCommand(argv.slice(1));
    return;
  }
  if (cmd === 'gh') {
    await ghCommand(argv.slice(1));
    return;
  }
  if (cmd !== 'serve') {
    console.error(`不明なコマンド: ${cmd}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  const githubRepo = arg(argv, '--github');
  let open: { repo: string; pr?: string; ref?: string } | null = null;
  if (githubRepo) {
    open = { repo: githubRepo, pr: arg(argv, '--pr'), ref: arg(argv, '--ref') };
    try {
      parseOpenRequest(open);
    } catch (e) {
      if (!(e instanceof OpenRequestError)) throw e;
      console.error(`${e.message}\n\n${HELP}`);
      process.exitCode = 2;
      return;
    }
  }
  const repoArg = arg(argv, '--repo');
  const repo = repoArg || !open ? path.resolve(repoArg ?? process.cwd()) : null;
  if (repo && !existsSync(repo)) throw new Error(`リポジトリが見つかりません: ${repo}`);
  const port = Number(arg(argv, '--port') ?? process.env.DDV_PORT ?? 5178);
  const host = arg(argv, '--host') ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.warn('[ddv] 警告: ループバック以外で待ち受けます。テスト実行 API が外部から呼べる状態になります');
  }
  const local = repo ? await createContext(repo) : undefined;
  const home = ddvHome();
  const { tokens, github, git } = githubDeps(home);
  const poll = Number(process.env.DDV_GITHUB_POLL ?? 60);
  const manager = new WorkspaceManager({ home, github, git, createContext: (dir) => createContext(dir), pollSeconds: Number.isFinite(poll) && poll >= 0 ? poll : 60 });
  await manager.init();
  const devOrigins = [...devOriginsFromEnv(), ...(arg(argv, '--dev-origin') ? [arg(argv, '--dev-origin')!] : [])];
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  const app = createServerApp({ local, manager, tokens, port, devOrigins, dist });
  const ws = open ? manager.open(open) : null;

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    if (repo) console.log(`[ddv] ${repo}`);
    if (ws) console.log(`[ddv] ${ws.id}（取得中）`);
    const hash = ws ? `#/w/${ws.id}/doc` : '';
    console.log(`[ddv] http://${host}:${info.port}/${existsSync(dist) ? hash : '  (API のみ。UI は npm run dev:web)'}`);
  });
  const stop = () => {
    manager.dispose();
    local?.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
