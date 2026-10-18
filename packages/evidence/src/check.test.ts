import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfig } from '@ddv/core/node';
import { checkEvidence, lintPlatforms } from './check.ts';

const SCN = 'docs/mocks/order/scenarios/BD-ORDER-SCREEN-P001.yaml';
const HOOKS = `import { defineEvidence } from '@ddv/evidence';
export const evidence = {
  'mail-log': defineEvidence({ params: { since: { required: true }, limit: { required: true, default: 10 } }, async run() { return []; } }),
  loose: defineEvidence(def),
};
`;

let base = '';
let n = 0;
beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-evcheck-'));
});
afterAll(() => fs.rm(base, { recursive: true, force: true }));

interface RepoOpts {
  evidence?: unknown;
  hooks?: string;
  files?: Record<string, string>;
  /** Extra runners (written as-is; the schema may strip unknown keys). */
  desktop?: boolean;
}

/** Scenario: step 1 inputs `customer`; step 2 carries the evidence items. */
const scenario = (items: unknown[], extraSteps = '') => `id: BD-ORDER-SCREEN-P001
title: t
start: List
steps:
  - event: 新規
    input: { customer: 山田 }
    click: new
    expect: { screen: Input }
  - event: 確定
    click: ok
    expect: { screen: Done }
    evidence: ${JSON.stringify(items)}
${extraSteps}`;

async function repo(scn: string | undefined, opts: RepoOpts = {}): Promise<string> {
  const dir = path.join(base, `r${++n}`);
  const files: Record<string, string> = {
    'ddv.config.yaml': YAML.stringify({ docsRoot: 'docs/design', mocksRoot: 'docs/mocks', ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}) }),
    ...(scn !== undefined ? { [SCN]: scn } : {}),
    ...(opts.hooks !== undefined ? { 'e2e/ddv-hooks.ts': opts.hooks } : {}),
    ...opts.files,
  };
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text, 'utf8');
  }
  return dir;
}

async function run(dir: string, desktop = false) {
  const config = await loadConfig(dir);
  if (desktop) (config.runners as unknown[]).push({ name: 'wpf', type: 'flaui', platform: 'wpf', cwd: '.', level: 'e2e' });
  return checkEvidence(dir, config, []);
}

const DB = { databases: { main: { type: 'sqlite', env: 'DDV_TEST_DB' } } };
const pre = (label: string) => `シナリオ BD-ORDER-SCREEN-P001 ステップ 2 の証跡 ${label}: `;
const err = (label: string, message: string) => ({ severity: 'error', rule: 'evidence', path: SCN, line: 12, message: pre(label) + message });
const warn = (label: string, message: string) => ({ ...err(label, message), severity: 'warning' });
const check = async (items: unknown[], opts: RepoOpts = {}) => run(await repo(scenario(items), opts), opts.desktop);

describe('指定の検査（checkEvidence）', () => {
  it('evidence の無いリポジトリには何も出さない（REQ-810）', async () => {
    expect(await run(await repo(scenario([]).replace(/    evidence: \[\]\r?\n/, '')))).toEqual([]);
    expect(await run(await repo(undefined))).toEqual([]);
  });

  it('[BD-EVICAP-CHECK-T003] 形式: validateScenario を通らないシナリオは evidence の検査をしない（形式は scenario の検査が出す）', async () => {
    expect(await check([{ use: 'nothing', at: 'later' }])).toEqual([]);
  });

  it('[BD-EVICAP-CHECK-P002] [BD-EVICAP-CHECK-T004] 未登録: 登録されていない取得手段', async () => {
    expect(await check([{ use: 'nothing' }], { hooks: HOOKS })).toEqual([
      err('nothing', '取得手段 nothing は登録されていません（組み込み：screenshot・db、登録：loose・mail-log）'),
    ]);
    // hooks を読めないときは確かめられない旨の warning（組み込み以外）
    expect(await check([{ use: 'nothing' }], { hooks: 'export const evidence = all;' })).toEqual([
      { severity: 'warning', rule: 'evidence', path: 'e2e/ddv-hooks.ts', message: 'hooks の evidence を読めません。名前と引数の検査を省きます' },
      warn('nothing', 'hooks を読めないため nothing の登録を確かめられません'),
    ]);
  });

  it('[BD-EVICAP-CHECK-P003] [BD-EVICAP-CHECK-T005] [BD-EVICAP-CHECK-T006] 引数の欠け: 必須で既定値の無い引数が無い', async () => {
    expect(await check([{ use: 'mail-log', label: 'メール' }], { hooks: HOOKS })).toEqual([err('メール', '必須の引数 since がありません')]);
    // 外部コマンドの params も同じ
    const evidence = { commands: { dump: { run: 'node', params: { dir: { required: true } } } } };
    expect(await check([{ use: 'dump' }], { evidence })).toEqual([err('dump', '必須の引数 dir がありません')]);
    // paramsKnown=false は調べない
    expect(await check([{ use: 'loose', with: { any: 1 } }], { hooks: HOOKS })).toEqual([]);
  });

  it('未知の引数: warning', async () => {
    expect(await check([{ use: 'mail-log', with: { since: 'x', foo: 1 } }], { hooks: HOOKS })).toEqual([warn('mail-log', '引数 foo は mail-log にありません')]);
    expect(await check([{ use: 'screenshot', with: { fullPage: true, color: 'red' } }])).toEqual([warn('screenshot', '引数 color は screenshot にありません')]);
  });

  it('input の参照: その時点（at）・プラットフォームで無い入力', async () => {
    const items = [
      { use: 'mail-log', label: 'a', with: { since: { input: 'customer' } } },
      { use: 'mail-log', label: 'b', at: 'before', with: { since: { input: 'sku' } } },
    ];
    expect(await check(items, { hooks: HOOKS })).toEqual([err('b', '入力 sku はこの時点（before）ではありません（web）')]);
    // 飛ばしたステップの入力は使えない（wpf では補助のステップ 1 が web だけ）
    const dir = await repo(scenario([{ use: 'mail-log', with: { since: { input: 'customer' } } }]).replace(/  - event: 新規\r?\n    (input: .*\r?\n    click: new\r?\n)    expect: .*\r?\n/, '  - $1    only: web\n'), { hooks: HOOKS });
    expect(await run(dir)).toEqual([]);
    expect(await run(dir, true)).toEqual([{ ...err('mail-log', '入力 customer はこの時点（after）ではありません（wpf）'), line: 11 }]);
  });

  it('[BD-EVICAP-CHECK-P004] [BD-EVICAP-CHECK-T007] [BD-EVICAP-CHECK-T008] db 以外で引数がそろえば OK', async () => {
    expect(await check([{ use: 'mail-log', with: { since: { input: 'customer' } } }, { use: 'screenshot', with: { fullPage: true } }], { hooks: HOOKS })).toEqual([]);
  });

  it('[BD-EVICAP-CHECK-P005] [BD-EVICAP-CHECK-T009] [BD-EVICAP-CHECK-T010] 接続先: mock でも databases の名前でもない', async () => {
    expect(await check([{ use: 'db', with: { db: 'other', sql: 'select 1' } }], { evidence: DB })).toEqual([
      err('db', '接続先 other は定義されていません（ddv.config.yaml の evidence.databases）'),
    ]);
    expect(await check([{ use: 'db', with: { db: 'mock', sql: 'select 1' } }])).toEqual([]);
    // デスクトップで with.db も defaultDatabase も無い
    expect(await check([{ use: 'db', with: { sql: 'select 1' } }], { desktop: true })).toEqual([
      err('db', '接続先が決まりません（with.db か evidence.defaultDatabase を書いてください）'),
    ]);
    expect(await check([{ use: 'db', with: { sql: 'select 1' } }], { desktop: true, evidence: { ...DB, defaultDatabase: 'main' } })).toEqual([]);
  });

  it('sql と file: どちらか一方', async () => {
    expect(await check([{ use: 'db', with: { db: 'main', sql: 'select 1', file: 'q.sql' } }], { evidence: DB })).toEqual([err('db', 'sql と file はどちらか一方を書きます')]);
    expect(await check([{ use: 'db', with: { db: 'main' } }], { evidence: DB })).toEqual([err('db', 'sql と file はどちらか一方を書きます')]);
  });

  it('[BD-EVICAP-CHECK-P006] [BD-EVICAP-CHECK-T011] [BD-EVICAP-CHECK-T012] SQL ファイル: リポジトリの中に無い', async () => {
    expect(await check([{ use: 'db', with: { db: 'main', file: 'sql/none.sql' } }], { evidence: DB })).toEqual([err('db', 'SQL ファイル sql/none.sql がありません')]);
    expect(await check([{ use: 'db', with: { db: 'main', file: '../outside.sql' } }], { evidence: DB, files: { '../outside.sql': 'select 1' } })).toEqual([
      err('db', 'SQL ファイル ../outside.sql がありません'),
    ]);
  });

  it('[BD-EVICAP-CHECK-P007] [BD-EVICAP-CHECK-T013] [BD-EVICAP-CHECK-T014] SELECT 以外: SqlGuard の理由', async () => {
    const files = { 'sql/del.sql': 'DELETE FROM orders', 'sql/two.sql': 'select 1; select 2' };
    expect(await check([{ use: 'db', label: 'x', with: { db: 'main', file: 'sql/del.sql' } }, { use: 'db', label: 'y', with: { db: 'main', file: 'sql/two.sql' } }], { evidence: DB, files })).toEqual([
      err('x', 'SELECT 以外の文は実行しない'),
      err('y', '複数の文は実行しない'),
    ]);
    expect(await check([{ use: 'db', with: { db: 'main', sql: 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x' } }], { evidence: DB })).toEqual([
      err('db', '読み取りでない文は実行しない（DELETE）'),
    ]);
  });

  it('[BD-EVICAP-CHECK-P008] [BD-EVICAP-CHECK-T015] SELECT・WITH の 1 文なら OK', async () => {
    const files = { 'sql/orders.sql': '\uFEFF-- 注文\nSELECT * FROM orders WHERE customer = :customer;\n' };
    const items = [{ use: 'db', with: { db: 'main', file: 'sql/orders.sql', params: { customer: { input: 'customer' } } } }];
    expect(await check(items, { evidence: DB, files })).toEqual([]);
  });

  it('パラメータ: SQL の :名前 が params に無い・params のキーが SQL に無い', async () => {
    const items = [{ use: 'db', with: { db: 'main', sql: 'select * from t where a = :a', params: { b: 1 } } }];
    expect(await check(items, { evidence: DB })).toEqual([err('db', 'パラメータ a がありません'), warn('db', 'パラメータ b は SQL で使っていません')]);
  });

  it('設定と一覧のエラーは設定ファイルに出す', async () => {
    const dir = await repo(undefined, { evidence: { databases: { main: { type: 'mysql', env: 'X' } }, commands: { db: { run: 'node' } } } });
    expect(await run(dir)).toEqual([
      { severity: 'error', rule: 'evidence', path: 'ddv.config.yaml', message: '接続先 main の type が不明です: mysql（sqlite / sqlserver / postgres）' },
      { severity: 'error', rule: 'evidence', path: 'ddv.config.yaml', message: '組み込みと同じ名前は登録できません: db' },
    ]);
  });

  it('同じ error はプラットフォームが違っても 1 回・run=false のステップはそのプラットフォームで調べない', async () => {
    const dir = await repo(scenario([{ use: 'nothing' }]), {});
    expect(await run(dir, true)).toEqual([err('nothing', '取得手段 nothing は登録されていません（組み込み：screenshot・db、登録：なし）')]);
    const wpfOnly = await repo(scenario([]).replace(/    evidence: \[\]\r?\n/, '') + '  - only: wpf\n    click: x\n    evidence: [{ use: nothing }]\n');
    expect(await run(wpfOnly)).toEqual([]);
    expect((await run(wpfOnly, true)).map((i) => i.message)).toEqual(['シナリオ BD-ORDER-SCREEN-P001 ステップ 3 の証跡 nothing: 取得手段 nothing は登録されていません（組み込み：screenshot・db、登録：なし）']);
  });

  it('lintPlatforms は web と flaui の platform', () => {
    expect(lintPlatforms({ runners: [] })).toEqual(['web']);
    expect(lintPlatforms({ runners: [{ type: 'flaui', platform: 'winforms' }, { type: 'flaui', platform: 'winforms' }] as never })).toEqual(['web', 'winforms']);
  });
});
