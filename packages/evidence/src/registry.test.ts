import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEvidenceConfig } from './config.ts';
import { scanEvidenceHooks, type HooksScan } from './hooks-scan.ts';
import { buildRegistry, loadRegistry, registeredNames } from './registry.ts';

const hooks = (...names: string[]): HooksScan => ({
  found: true,
  readable: true,
  warnings: [],
  providers: names.map((name) => ({ name, kind: 'hooks', params: {}, paramsKnown: false, source: 'e2e/ddv-hooks.ts' })),
});
const commands = (...names: string[]) => parseEvidenceConfig({ commands: Object.fromEntries(names.map((n) => [n, { run: 'node' }])) }).config;
const build = (h: string[], c: string[]) => buildRegistry(commands(...c), hooks(...h));

describe('取得手段の一覧（REGMERGE）', () => {
  it('[DD-EVSPEC-REGMERGE-P001] [DD-EVSPEC-REGMERGE-T001] [DD-EVSPEC-REGMERGE-T002] 組み込みと同じ名前は登録できない', () => {
    const r = build(['db'], ['screenshot']);
    expect(r.issues).toEqual([
      { severity: 'error', source: 'e2e/ddv-hooks.ts', message: '組み込みと同じ名前は登録できません: db' },
      { severity: 'error', source: 'ddv.config.yaml', message: '組み込みと同じ名前は登録できません: screenshot' },
    ]);
    expect(r.get('db')?.kind).toBe('builtin');
    expect(r.get('screenshot')?.kind).toBe('builtin');
  });

  it('[DD-EVSPEC-REGMERGE-P002] [DD-EVSPEC-REGMERGE-T003] [DD-EVSPEC-REGMERGE-T004] hooks と設定の両方にある名前はエラー', () => {
    const r = build(['mail', 'a'], ['mail', 'b']);
    expect(r.issues).toEqual([{ severity: 'error', source: 'ddv.config.yaml', message: 'hooks と設定の両方に同じ名前があります: mail' }]);
    expect(r.get('mail')).toBeUndefined();
    expect([...r.providers.keys()]).toEqual(['screenshot', 'db', 'a', 'b']);
  });

  it('[DD-EVSPEC-REGMERGE-P003] [DD-EVSPEC-REGMERGE-T005] [DD-EVSPEC-REGMERGE-T006] 使えない文字や長すぎる名前はエラー', () => {
    const long = 'a'.repeat(65);
    const r = build(['メール', 'a b'], [long]);
    expect(r.issues.map((i) => i.message)).toEqual([
      'a b', 'メール', long,
    ].map((n) => `取得手段の名前に使えない文字があります（英数字・-・_ で 1〜64 文字）: ${n}`));
    expect(r.providers.size).toBe(2);
  });

  it('[DD-EVSPEC-REGMERGE-P004] [DD-EVSPEC-REGMERGE-T007] 正しい名前は 組み込み → hooks → commands の名前順に加える', () => {
    const r = build(['z-hook', 'A_1'], ['cmd', 'a'.repeat(64)]);
    expect(r.issues).toEqual([]);
    expect([...r.providers.values()].map((p) => [p.name, p.kind])).toEqual([
      ['screenshot', 'builtin'],
      ['db', 'builtin'],
      ['A_1', 'hooks'],
      ['z-hook', 'hooks'],
      ['a'.repeat(64), 'command'],
      ['cmd', 'command'],
    ]);
    expect(registeredNames(build(['h'], ['c']))).toBe('組み込み：screenshot・db、登録：h・c');
    expect(registeredNames(build([], []))).toBe('組み込み：screenshot・db、登録：なし');
  });
});

describe('取得手段の解決（RESOLVE）', () => {
  let repo = '';
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-evreg-'));
    await fs.mkdir(path.join(repo, 'e2e'));
    await fs.writeFile(
      path.join(repo, 'e2e/ddv-hooks.ts'),
      "import { defineEvidence } from '@ddv/evidence';\nexport const evidence = { 'mail-log': defineEvidence({ params: { since: { required: true } }, async run() { return []; } }) };\n",
    );
  });
  afterAll(() => fs.rm(repo, { recursive: true, force: true }));
  const load = () => loadRegistry(repo, { evidence: { commands: { 'file-dump': { run: 'node', params: { dir: { default: 'out' } } } } } });

  it('[BD-EVICAP-RESOLVE-P001] [BD-EVICAP-RESOLVE-T001] [BD-EVICAP-RESOLVE-T002] [BD-EVICAP-RESOLVE-S001] screenshot・db は組み込み', async () => {
    const r = await load();
    expect(r.get('screenshot')).toMatchObject({ kind: 'builtin', source: 'builtin' });
    expect(r.get('db')).toMatchObject({ kind: 'builtin', paramsKnown: true });
  });

  it('[BD-EVICAP-RESOLVE-P002] [BD-EVICAP-RESOLVE-T003] [BD-EVICAP-RESOLVE-T004] [BD-EVICAP-RESOLVE-S002] [BD-EVICAP-RESOLVE-S003] hooks の evidence にあれば hooks の関数', async () => {
    const r = await load();
    expect(r.get('mail-log')).toEqual({ name: 'mail-log', kind: 'hooks', params: { since: { required: true } }, paramsKnown: true, source: 'e2e/ddv-hooks.ts' });
    expect(r.hooks).toMatchObject({ found: true, readable: true });
  });

  it('[BD-EVICAP-RESOLVE-P003] [BD-EVICAP-RESOLVE-T005] [BD-EVICAP-RESOLVE-T006] [BD-EVICAP-RESOLVE-S004] [BD-EVICAP-RESOLVE-S005] 設定の evidence.commands にあれば外部コマンド', async () => {
    const r = await load();
    expect(r.get('file-dump')).toEqual({ name: 'file-dump', kind: 'command', params: { dir: { required: false, default: 'out' } }, paramsKnown: true, source: 'ddv.config.yaml' });
  });

  it('[BD-EVICAP-RESOLVE-P004] [BD-EVICAP-RESOLVE-T007] [BD-EVICAP-RESOLVE-S006] どこにも無ければ登録されていない名前', async () => {
    const r = await load();
    expect(r.get('nothing')).toBeUndefined();
    expect(r.issues).toEqual([]);
    // hooks ファイルが無いリポジトリでも組み込みは使える
    const empty = await loadRegistry(path.join(repo, 'e2e'), {});
    expect([...empty.providers.keys()]).toEqual(['screenshot', 'db']);
    expect(empty.hooks.found).toBe(false);
  });

  it('hooks の警告は一覧の issue になる', () => {
    const r = buildRegistry(commands(), scanEvidenceHooks('export const evidence = all;'));
    expect(r.issues).toEqual([{ severity: 'warning', source: 'e2e/ddv-hooks.ts', message: 'hooks の evidence を読めません。名前と引数の検査を省きます' }]);
  });
});
