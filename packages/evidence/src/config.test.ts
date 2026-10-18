import { describe, expect, it } from 'vitest';
import { parseEvidenceConfig } from './config.ts';

const db = (over: Record<string, unknown> = {}) => ({ type: 'sqlite', env: 'DDV_DB', ...over });

describe('設定の検査（CFGCHK）', () => {
  it('[DD-EVSPEC-CFGCHK-P001] [DD-EVSPEC-CFGCHK-T001] [DD-EVSPEC-CFGCHK-T002] スキーマに合わなければ zod の最初のエラー', () => {
    const r = parseEvidenceConfig({ timeout: 50, maxRows: 0 });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^設定 evidence の形式が不正です: evidence\.timeout: /);
    expect(parseEvidenceConfig({ unknown: 1 }).errors[0]).toMatch(/^設定 evidence の形式が不正です: evidence: /);
    expect(parseEvidenceConfig({ databases: { mock: db() } }).errors).toEqual(['設定 evidence の形式が不正です: evidence.databases.mock: 接続先の名前 mock は使えません']);
    expect(parseEvidenceConfig({ databases: { main: db({ env: 'not-env' }) } }).errors[0]).toContain('env は環境変数の名前');
    // 既定値の設定に戻す
    expect(r.config.timeout).toBe(30_000);
  });

  it('[DD-EVSPEC-CFGCHK-P002] [DD-EVSPEC-CFGCHK-T003] [DD-EVSPEC-CFGCHK-T004] type が不明ならエラー', () => {
    const r = parseEvidenceConfig({ databases: { main: db({ type: 'mysql' }), ok: db() } });
    expect(r.errors).toEqual(['接続先 main の type が不明です: mysql（sqlite / sqlserver / postgres）']);
    expect(Object.keys(r.config.databases)).toEqual(['ok']);
  });

  it('[DD-EVSPEC-CFGCHK-P003] [DD-EVSPEC-CFGCHK-T005] [DD-EVSPEC-CFGCHK-T006] env が無ければエラー', () => {
    const r = parseEvidenceConfig({ databases: { main: { type: 'postgres' } } });
    expect(r.errors).toEqual(['接続先 main に env（接続文字列の環境変数の名前）が必要です']);
    expect(r.config.databases).toEqual({});
  });

  it('[DD-EVSPEC-CFGCHK-P004] [DD-EVSPEC-CFGCHK-T007] [DD-EVSPEC-CFGCHK-T008] defaultDatabase が mock でも databases の名前でもなければエラー', () => {
    expect(parseEvidenceConfig({ defaultDatabase: 'main' }).errors).toEqual(['defaultDatabase の接続先 main がありません（mock か evidence.databases の名前）']);
    expect(parseEvidenceConfig({ defaultDatabase: 'mock' }).errors).toEqual([]);
    expect(parseEvidenceConfig({ defaultDatabase: 'main', databases: { main: db() } }).errors).toEqual([]);
  });

  it('[DD-EVSPEC-CFGCHK-P005] [DD-EVSPEC-CFGCHK-T009] [DD-EVSPEC-CFGCHK-T010] commands の run が空ならエラー', () => {
    const r = parseEvidenceConfig({ commands: { a: { run: ' ' }, b: { args: ['x'] }, c: { run: 'node' } } });
    expect(r.errors).toEqual(['取得手段 a の run（実行ファイル）が必要です', '取得手段 b の run（実行ファイル）が必要です']);
    expect(Object.keys(r.config.commands)).toEqual(['c']);
  });

  it('[DD-EVSPEC-CFGCHK-P006] [DD-EVSPEC-CFGCHK-T011] 正しい設定は既定値を補って使える', () => {
    const r = parseEvidenceConfig({
      defaultDatabase: 'main',
      databases: { main: db({ type: 'sqlserver', mask: ['Email'] }) },
      commands: { 'mail-log': { run: 'node', args: ['tools/mail.mjs'], params: { since: { required: true } }, timeout: 5000 } },
    });
    expect(r.errors).toEqual([]);
    expect(r.config).toEqual({
      timeout: 30_000,
      maxRows: 200,
      maxBytes: 1_048_576,
      maxFileBytes: 5_242_880,
      defaultDatabase: 'main',
      databases: { main: { type: 'sqlserver', env: 'DDV_DB', mask: ['Email'] } },
      commands: { 'mail-log': { run: 'node', args: ['tools/mail.mjs'], cwd: '.', params: { since: { required: true } }, output: 'dir', timeout: 5000 } },
    });
    // 書かなければ既定値・エラーなし（REQ-810）
    expect(parseEvidenceConfig(undefined)).toEqual({ config: { timeout: 30_000, maxRows: 200, maxBytes: 1_048_576, maxFileBytes: 5_242_880, databases: {}, commands: {} }, errors: [] });
  });
});
