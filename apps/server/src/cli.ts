#!/usr/bin/env node
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { loadConfig } from '@ddv/core/node';
import { initMocks, scaffoldMock } from '@ddv/mock';
import { createApp, createContext, mimeOf } from './app.ts';
import { SnapshotService } from './snapshots.ts';

const HELP = `ddv - Design Doc Viewer

使い方:
  ddv serve [--repo <path>] [--port <n>] [--host 127.0.0.1]
      ローカルリポジトリを閲覧するサーバを起動します（既定: カレント, 5178）
      apps/web/dist が無い場合は API のみ提供します（開発時は npm run dev:web）
  ddv mock scaffold [--repo <path>] [--mock <name>]
      画面遷移図の経路（P）ごとにシナリオの骨組みを生成・マージします（ddv-testid generate の後に実行）
  ddv mock init [--repo <path>]
      モックの runtime（<mocksRoot>/_ddv/mock-runtime.js）と固定の spec（e2e/ddv-scenarios.spec.ts）を配置します
  ddv mock snapshot [--repo <path>] [--id <ID>] [--approve]
      シナリオを再生して各ステップの画面を撮影し、基準画像と比較します（--id 省略時は全シナリオ）
      --approve: 今回の撮影結果を基準として承認します（.ddv/snapshots/baseline/ へコピー）
      ブラウザは mock.browser.channel（環境変数 DDV_BROWSER_CHANNEL で上書き可）

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
  if (cmd !== 'serve') {
    console.error(`不明なコマンド: ${cmd}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  const repo = path.resolve(arg(argv, '--repo') ?? process.cwd());
  if (!existsSync(repo)) throw new Error(`リポジトリが見つかりません: ${repo}`);
  const port = Number(arg(argv, '--port') ?? process.env.DDV_PORT ?? 5178);
  const host = arg(argv, '--host') ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.warn('[ddv] 警告: ループバック以外で待ち受けます。テスト実行 API が外部から呼べる状態になります');
  }
  const ctx = await createContext(repo);
  const app = createApp(ctx);

  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(dist)) {
    app.get('*', async (c) => {
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '');
      let abs = path.resolve(dist, rel);
      if (!abs.startsWith(dist) || !(await fs.stat(abs).catch(() => null))?.isFile()) abs = path.join(dist, 'index.html');
      return new Response(await fs.readFile(abs), { headers: { 'content-type': mimeOf(abs) } });
    });
  }

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`[ddv] ${repo}`);
    console.log(`[ddv] http://${host}:${info.port}/${existsSync(dist) ? '' : '  (API のみ。UI は npm run dev:web)'}`);
  });
  const stop = () => {
    ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
