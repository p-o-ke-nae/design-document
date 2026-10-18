import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { evidenceCommand, parseWithArgs, type EvidenceIo, type TryRequest, type TryResult } from './cli.ts';

const HOOKS = `import { defineEvidence } from '@ddv/evidence';
export const evidence = {
  'mail-log': defineEvidence({ params: { since: { required: true } }, async run() { return []; } }),
};
`;

let repo = '';
beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-evcli-'));
  await fs.writeFile(
    path.join(repo, 'ddv.config.yaml'),
    YAML.stringify({ docsRoot: 'docs/design', mocksRoot: 'docs/mocks', evidence: { databases: { main: { type: 'sqlite', env: 'DDV_TEST_DB' } } } }),
  );
  await fs.mkdir(path.join(repo, 'e2e'));
  await fs.writeFile(path.join(repo, 'e2e/ddv-hooks.ts'), HOOKS);
});
afterAll(() => fs.rm(repo, { recursive: true, force: true }));

function io(result?: TryResult) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: TryRequest[] = [];
  const value: EvidenceIo = {
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    cwd: repo,
    env: {},
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    capture: async (req) => {
      requests.push(req);
      return result ?? { status: 'ok', files: [], durationMs: 0 };
    },
  };
  return { value, out, err, requests };
}

describe('ddv evidence try', () => {
  it('[DD-EVSPEC-TRY-P001] [DD-EVSPEC-TRY-T001] [DD-EVSPEC-TRY-T002] 登録されていない名前は終了コード 2', async () => {
    const t = io();
    expect(await evidenceCommand(['try', 'nothing'], t.value)).toBe(2);
    expect(t.err).toEqual(['取得手段 nothing は登録されていません']);
    expect(t.requests).toEqual([]);
  });

  it('[DD-EVSPEC-TRY-P002] [DD-EVSPEC-TRY-T003] [DD-EVSPEC-TRY-T004] screenshot は画面の操作が要るので終了コード 2', async () => {
    const t = io();
    expect(await evidenceCommand(['try', 'screenshot'], t.value)).toBe(2);
    expect(t.err).toEqual(['screenshot は画面の操作が要るため try では使えません']);
    expect(t.requests).toEqual([]);
  });

  it('[DD-EVSPEC-TRY-P003] [DD-EVSPEC-TRY-T005] [DD-EVSPEC-TRY-T006] [DD-EVSPEC-TRY-T007] [DD-EVSPEC-TRY-T008] ok: with を作って captureOne に渡し、種類・ファイル・大きさ・時間を表示する', async () => {
    const t = io({ status: 'ok', files: [{ kind: 'table', path: '/tmp/x/db.csv', bytes: 42 }], durationMs: 12 });
    expect(await evidenceCommand(['try', 'db', '--with', 'sql=select 1', '--with', 'limit=5', '--db', 'main', '--out', 'out'], t.value)).toBe(0);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0].spec).toMatchObject({ use: 'db', at: 'after', with: { sql: 'select 1', limit: 5, db: 'main' } });
    expect(t.requests[0].outDir).toBe(path.join(repo, 'out'));
    expect(t.out).toEqual(['ok: db（12 ms）', '  table  /tmp/x/db.csv  42 bytes', `出力: ${path.join(repo, 'out')}`]);
    // --out が無いときは一時フォルダ
    const t2 = io();
    expect(await evidenceCommand(['try', 'mail-log', '--with', 'since=x'], t2.value)).toBe(0);
    expect(t2.requests[0].outDir).toBe(path.join(os.tmpdir(), 'ddv-evidence-try-2026-01-02T03-04-05-000Z'));
  });

  it('[DD-EVSPEC-TRY-P004] [DD-EVSPEC-TRY-T009] failed: 理由を表示して終了コード 1', async () => {
    const t = io({ status: 'failed', reason: '接続できません（password=***）', files: [], durationMs: 3 });
    expect(await evidenceCommand(['try', 'mail-log', '--with', 'since=x'], t.value)).toBe(1);
    expect(t.out).toEqual(['failed: mail-log（3 ms）— 接続できません（password=***）']);
  });

  it('引数の誤り・mock の DB は終了コード 2', async () => {
    const bad = io();
    expect(await evidenceCommand(['try', 'mail-log', '--with', 'novalue'], bad.value)).toBe(2);
    expect(bad.err).toEqual(['--with は key=value で書いてください: novalue']);
    const mock = io();
    expect(await evidenceCommand(['try', 'db', '--db', 'mock', '--with', 'sql=select 1'], mock.value)).toBe(2);
    expect(mock.err).toEqual(['mock の疑似 DB は E2E の実行でだけ使えます']);
    const tmo = io();
    expect(await evidenceCommand(['try', 'mail-log', '--timeout', '0'], tmo.value)).toBe(2);
    expect(tmo.requests).toEqual([]);
  });

  it('--with の値: 真偽・数値を変換し、同じキーは配列にする', () => {
    expect(parseWithArgs(['a=true', 'b=false', 'c=-1.5', 'd=x', 'd=2', 'e=a=b'])).toEqual({ a: true, b: false, c: -1.5, d: ['x', 2], e: 'a=b' });
  });
});

describe('ddv evidence list', () => {
  it('取得手段と接続先（環境変数の有無）を JSON で出す', async () => {
    const t = io();
    t.value.env = { DDV_TEST_DB: 'x.db' };
    expect(await evidenceCommand(['list', '--json'], t.value)).toBe(0);
    const j = JSON.parse(t.out.join('\n')) as { providers: { name: string }[]; databases: unknown[] };
    expect(j.providers.map((p) => p.name)).toEqual(expect.arrayContaining(['screenshot', 'db', 'mail-log']));
    expect(j.databases).toEqual([{ name: 'main', type: 'sqlite', env: 'DDV_TEST_DB', present: true }]);
  });

  it('不明なサブコマンドは終了コード 2', async () => {
    const t = io();
    expect(await evidenceCommand(['nope'], t.value)).toBe(2);
  });
});
