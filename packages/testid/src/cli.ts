#!/usr/bin/env node
import path from 'node:path';
import { loadConfig } from '@ddv/core/node';
import { activeIds } from './matrix.ts';
import { generateAll, readLock } from './lock-io.ts';
import { scanTestLinks } from './scan.ts';
import { LOCK_PATH } from './lock.ts';

const HELP = `ddv-testid <command> [--repo <path>] [--json] [--strict]

  generate   図からマトリクスを生成し、テストIDを採番して ${LOCK_PATH} を更新する
  list       有効なテストIDを一覧表示する
  check      ロックが最新か、テストコードのID紐づけ（未実装・存在しないID）を検査する
  show <id>  テストIDの経路・期待結果・紐づくテストを表示する
`;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repo = path.resolve(opt('--repo') ?? '.');
const json = args.includes('--json');
const strict = args.includes('--strict');

async function main(): Promise<number> {
  const config = await loadConfig(repo);
  switch (cmd) {
    case 'generate': {
      const r = await generateAll(repo, config, { write: true });
      const added = r.matrices.flatMap((m) => m.cases.filter((c) => c.provisional));
      const retired = r.matrices.flatMap((m) => m.retired);
      if (json) console.log(JSON.stringify({ changed: r.changed, added: added.map((c) => c.id), retired: retired.map((x) => x.id) }, null, 2));
      else {
        for (const m of r.matrices) console.log(`${m.diagramKey}  ${m.doc}#${m.diagram}  cases=${m.cases.length}`);
        console.log(`\n追加: ${added.length}  欠番化: ${retired.length}  ${r.changed ? `→ ${LOCK_PATH} を更新しました` : '（変更なし）'}`);
        for (const m of r.matrices) for (const w of m.warnings) console.log(`! ${m.diagramKey}: ${w}`);
      }
      return 0;
    }
    case 'list': {
      const lock = await readLock(repo);
      const ids = [...activeIds(lock)].sort(([a], [b]) => a.localeCompare(b));
      if (json) console.log(JSON.stringify(ids.map(([id, v]) => ({ id, ...v })), null, 2));
      else for (const [id, v] of ids) console.log(`${id}\t${v.title}`);
      return 0;
    }
    case 'check': {
      const r = await generateAll(repo, config, { write: false });
      const active = activeIds(r.lock);
      const links = await scanTestLinks(repo, config);
      const linked = new Set(links.map((l) => l.id));
      const unimplemented = [...active.keys()].filter((id) => !linked.has(id)).sort();
      const orphans = links.filter((l) => !active.has(l.id));
      const result = { lockOutdated: r.changed, unimplemented, orphans };
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(r.changed ? `✗ ${LOCK_PATH} が図と一致しません。ddv-testid generate を実行してください` : `✓ ${LOCK_PATH} は最新です`);
        console.log(`${unimplemented.length ? '!' : '✓'} 未実装のテストID: ${unimplemented.length}`);
        for (const id of unimplemented) console.log(`    ${id}\t${active.get(id)!.title}`);
        console.log(`${orphans.length ? '✗' : '✓'} 存在しない/欠番のテストIDを参照するテスト: ${orphans.length}`);
        for (const o of orphans) console.log(`    ${o.id}\t${o.file}:${o.line}`);
      }
      return r.changed || orphans.length || (strict && unimplemented.length) ? 1 : 0;
    }
    case 'show': {
      const id = args[1];
      const r = await generateAll(repo, config, { write: false });
      const c = r.matrices.flatMap((m) => m.cases.map((x) => ({ m, x }))).find(({ x }) => x.id === id);
      if (!c) {
        console.error(`テストID ${id} は見つかりません`);
        return 1;
      }
      const links = (await scanTestLinks(repo, config)).filter((l) => l.id === id);
      const info = { id, doc: c.m.doc, diagram: c.m.diagram, kind: c.x.kind, title: c.x.title, nodes: c.x.nodes, expected: c.x.expected, tests: links };
      if (json) console.log(JSON.stringify(info, null, 2));
      else {
        console.log(`${id}  (${c.m.doc}#${c.m.diagram})\n  経路: ${c.x.title}\n  期待: ${c.x.expected}`);
        for (const l of links) console.log(`  テスト: [${l.runner}] ${l.file}:${l.line} ${l.test}`);
      }
      return 0;
    }
    default:
      console.log(HELP);
      return cmd ? 1 : 0;
  }
}

process.exit(await main());
