import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@ddv/core';
import { assignIds, formatId, globToRegExp, idPattern, sanitizeCode, scanTestLinks, type LockDiagram } from './index.ts';
import type { TestCase } from '@ddv/graph';

const tc = (kind: TestCase['kind'], signature: string): TestCase => ({ kind, signature, title: signature, edges: [], nodes: [], expected: '' });

describe('assignIds', () => {
  it('keeps ids stable, retires removed and appends new', () => {
    const entry: LockDiagram = { doc: 'a.md', diagram: 'd', next: {}, cases: {} };
    const r1 = assignIds(entry, 'BD-ORDER-ST', [tc('T', 'a'), tc('T', 'b'), tc('P', 'p')]);
    expect(r1.cases.map((c) => c.id)).toEqual(['BD-ORDER-ST-T001', 'BD-ORDER-ST-T002', 'BD-ORDER-ST-P001']);
    expect(r1.cases.every((c) => c.provisional)).toBe(true);

    const r2 = assignIds(entry, 'BD-ORDER-ST', [tc('T', 'c'), tc('T', 'b')]);
    expect(r2.cases.map((c) => [c.id, c.provisional])).toEqual([
      ['BD-ORDER-ST-T003', true],
      ['BD-ORDER-ST-T002', false],
    ]);
    expect(r2.retired.map((x) => x.id).sort()).toEqual(['BD-ORDER-ST-P001', 'BD-ORDER-ST-T001']);

    const r3 = assignIds(entry, 'BD-ORDER-ST', [tc('T', 'a'), tc('T', 'b'), tc('T', 'c')]);
    expect(r3.cases.map((c) => c.id)).toEqual(['BD-ORDER-ST-T001', 'BD-ORDER-ST-T002', 'BD-ORDER-ST-T003']);
    expect(entry.cases.p.status).toBe('retired');
    const r4 = assignIds(entry, 'BD-ORDER-ST', [tc('T', 'a'), tc('T', 'b'), tc('T', 'c')]);
    expect(r4.changed).toBe(false);
  });
});

describe('テストIDの状態（DD-TESTID-LOCK）', () => {
  const fresh = (): LockDiagram => ({ doc: 'a.md', diagram: 'd', next: {}, cases: {} });
  const ids = (r: ReturnType<typeof assignIds>) => r.cases.map((c) => c.id);

  it('[DD-TESTID-LOCK-T001] 新しい経路は種別ごとの末尾番号で有効になる', () => {
    const e = fresh();
    expect(ids(assignIds(e, 'BD-X-Y', [tc('T', 'a'), tc('P', 'p'), tc('T', 'b')]))).toEqual(['BD-X-Y-T001', 'BD-X-Y-P001', 'BD-X-Y-T002']);
    expect(Object.values(e.cases).every((c) => c.status === 'active')).toBe(true);
  });

  it('[DD-TESTID-LOCK-T002] 経路が残っていればIDは変わらず有効のまま', () => {
    const e = fresh();
    assignIds(e, 'BD-X-Y', [tc('T', 'a'), tc('T', 'b')]);
    const r = assignIds(e, 'BD-X-Y', [tc('T', 'b'), tc('T', 'a')]);
    expect(ids(r)).toEqual(['BD-X-Y-T002', 'BD-X-Y-T001']);
    expect(r.changed).toBe(false);
  });

  it('[DD-TESTID-LOCK-T003] 経路が消えると欠番になり番号は再利用しない', () => {
    const e = fresh();
    assignIds(e, 'BD-X-Y', [tc('T', 'a'), tc('T', 'b')]);
    const r = assignIds(e, 'BD-X-Y', [tc('T', 'b'), tc('T', 'c')]);
    expect(r.retired.map((x) => x.id)).toEqual(['BD-X-Y-T001']);
    expect(e.cases.a.status).toBe('retired');
    expect(ids(r)).toEqual(['BD-X-Y-T002', 'BD-X-Y-T003']);
  });

  it('[DD-TESTID-LOCK-T004] 欠番の経路が復活すると元の番号で有効に戻る', () => {
    const e = fresh();
    assignIds(e, 'BD-X-Y', [tc('T', 'a'), tc('T', 'b')]);
    assignIds(e, 'BD-X-Y', [tc('T', 'b')]);
    const r = assignIds(e, 'BD-X-Y', [tc('T', 'a'), tc('T', 'b')]);
    expect(ids(r)).toEqual(['BD-X-Y-T001', 'BD-X-Y-T002']);
    expect(e.cases.a.status).toBe('active');
  });

  it('[DD-TESTID-LOCK-T005] 欠番のまま再生成しても欠番が維持される', () => {
    const e = fresh();
    assignIds(e, 'BD-X-Y', [tc('T', 'a'), tc('T', 'b')]);
    assignIds(e, 'BD-X-Y', [tc('T', 'b')]);
    const r = assignIds(e, 'BD-X-Y', [tc('T', 'b')]);
    expect(e.cases.a.status).toBe('retired');
    expect(r.retired).toEqual([]);
    expect(r.changed).toBe(false);
  });
});

describe('scanTestLinks', () => {
  it('links only test declarations for JS runners, any attribute for dotnet', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-scan-'));
    await fs.mkdir(path.join(repo, 'web'));
    await fs.mkdir(path.join(repo, 'cs'));
    // Uses its own prefixes (XB/XD) so these fixtures are not picked up as links of this repository.
    await fs.writeFile(
      path.join(repo, 'web/a.test.ts'),
      ["it('[XB-A-B-T001] ok', () => {", "  expect(id).toBe('XB-A-B-T002');", '});', "test('x', { tag: '@XB-A-B-T003' }, () => {});"].join('\n'),
    );
    await fs.writeFile(path.join(repo, 'cs/T.cs'), ['namespace N;', 'public class C {', '  [Fact, Trait("TestId", "XD-A-B-T001")]', '  public void M() {}', '}'].join('\n'));
    const config = parseConfig({
      idPrefix: { requirements: 'XR', basic: 'XB', detailed: 'XD' },
      runners: [
        { name: 'web', type: 'vitest', cwd: 'web', level: 'unit' },
        { name: 'dotnet', type: 'dotnet', cwd: 'cs', level: 'unit' },
      ],
    });
    const links = await scanTestLinks(repo, config);
    expect(links.map((l) => [l.id, l.test])).toEqual([
      ['XB-A-B-T001', '[XB-A-B-T001] ok'],
      ['XB-A-B-T003', 'x'],
      ['XD-A-B-T001', 'N.C.M'],
    ]);
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('links scenario YAML ids for playwright runners with scenarios: true', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-scan-'));
    const dir = path.join(repo, 'mocks/order/scenarios');
    await fs.mkdir(path.join(dir, '_retired'), { recursive: true });
    await fs.writeFile(path.join(dir, 'XB-O-S-P001.yaml'), '# comment\nid: XB-O-S-P001\ntitle: 一覧 → 入力\nstart: List\nsteps: []\n');
    await fs.writeFile(path.join(dir, '_retired/XB-O-S-P002.yaml'), 'id: XB-O-S-P002\n');
    await fs.writeFile(path.join(dir, '_map.yaml'), 'screens: {}\n');
    const runner = { name: 'e2e', type: 'playwright' as const, cwd: 'e2e', level: 'integration' as const };
    const off = parseConfig({ mocksRoot: 'mocks', idPrefix: { requirements: 'XR', basic: 'XB', detailed: 'XD' }, runners: [runner] });
    expect(await scanTestLinks(repo, off)).toEqual([]);
    const on = parseConfig({ mocksRoot: 'mocks', idPrefix: { requirements: 'XR', basic: 'XB', detailed: 'XD' }, runners: [{ ...runner, scenarios: true }] });
    expect(await scanTestLinks(repo, on)).toEqual([
      { id: 'XB-O-S-P001', runner: 'e2e', level: 'integration', file: 'mocks/order/scenarios/XB-O-S-P001.yaml', line: 2, test: '一覧 → 入力' },
    ]);
    await fs.rm(repo, { recursive: true, force: true });
  });
});

describe('helpers', () => {
  it('formats and matches ids', () => {
    expect(sanitizeCode('order-state')).toBe('ORDER-STATE');
    expect(sanitizeCode('ｏｒｄｅｒ　1')).toBe('ORDER-1');
    const id = formatId('BD-ORDER-ORDER-STATE', 'X', 7);
    expect(id).toBe('BD-ORDER-ORDER-STATE-X007');
    expect(`test('[${id}] x')`.match(idPattern(['BD', 'DD']))).toEqual([id]);
    expect('REQ-001 BD-A-B-Q001'.match(idPattern(['BD']))).toBeNull();
  });

  it('converts globs', () => {
    expect(globToRegExp('**/*.test.ts').test('src/a/b.test.ts')).toBe(true);
    expect(globToRegExp('**/*.test.ts').test('b.test.ts')).toBe(true);
    expect(globToRegExp('src/*.{ts,tsx}').test('src/a.tsx')).toBe(true);
    expect(globToRegExp('src/*.{ts,tsx}').test('src/x/a.tsx')).toBe(false);
  });
});
