import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@ddv/core';
import { createApp, createContext } from './app.ts';
import { buildInvocation, mapResults, parseJUnit, parseTrx } from './runner.ts';
import { RunManager, type RunRecord } from './runs.ts';

const SAMPLE = path.resolve(import.meta.dirname, '../../../examples/sample-app');

describe('report parsers', () => {
  it('parses JUnit with failure and skipped', () => {
    const xml = `<testsuites><testsuite name="a">
      <testcase classname="src/a.test.ts" name="flow &gt; [BD-X-Y-T001] ok" time="0.012"></testcase>
      <testcase classname="src/a.test.ts" name="[BD-X-Y-T002] ng" time="0.5"><failure message="expected 1 to be 2" type="AssertionError">stack</failure></testcase>
      <testcase classname="src/a.test.ts" name="[BD-X-Y-T003] skip" time="0"><skipped/></testcase>
    </testsuite></testsuites>`;
    const r = parseJUnit(xml);
    expect(r.map((x) => x.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(r[0].name).toContain('flow > [BD-X-Y-T001] ok');
    expect(r[1].message).toBe('expected 1 to be 2');
    expect(r[1].durationMs).toBe(500);
  });

  it('parses TRX', () => {
    const xml = `<TestRun><Results>
      <UnitTestResult testName="Ns.C.A" outcome="Passed" duration="00:00:00.0150000" />
      <UnitTestResult testName="Ns.C.B" outcome="Failed" duration="00:00:01.5"><Output><ErrorInfo><Message>Assert.Equal() Failure</Message></ErrorInfo></Output></UnitTestResult>
    </Results></TestRun>`;
    const r = parseTrx(xml);
    expect(r).toEqual([
      { name: 'Ns.C.A', status: 'passed', durationMs: 15, message: undefined },
      { name: 'Ns.C.B', status: 'failed', durationMs: 1500, message: 'Assert.Equal() Failure' },
    ]);
  });

  it('maps results to ids by title and by linked FQN', () => {
    const re = /\b(?:BD|DD)(?:-[A-Z0-9]+)+-[PTSX]\d{3}\b/g;
    const js = mapResults({ name: 'web', type: 'vitest', cwd: '.', level: 'unit', scenarios: false }, [{ name: 'f [BD-A-B-T001] x', status: 'passed', durationMs: 1 }], [], re, null);
    expect(Object.keys(js)).toEqual(['BD-A-B-T001']);
    const links = [{ id: 'DD-A-B-T001', runner: 'dotnet', level: 'unit' as const, file: 'a.cs', line: 1, test: 'Ns.C.M' }];
    const cs = mapResults({ name: 'dotnet', type: 'dotnet', cwd: '.', level: 'unit', scenarios: false }, [{ name: 'Ns.C.M', status: 'failed', durationMs: 2 }], links, re, new Set(['DD-A-B-T001']));
    expect(cs['DD-A-B-T001'].status).toBe('failed');
  });

  it('filters dotnet tests by linked FQN (framework independent)', () => {
    const r = { name: 'dotnet', type: 'dotnet' as const, cwd: '.', level: 'unit' as const, scenarios: false };
    const links = [
      { id: 'DD-A-B-T001', runner: 'dotnet', level: 'unit' as const, file: 'a.cs', line: 1, test: 'Ns.C.M1' },
      { id: 'DD-A-B-T002', runner: 'dotnet', level: 'unit' as const, file: 'a.cs', line: 9, test: 'Ns.C.M2' },
    ];
    const inv = buildInvocation(SAMPLE, r, ['DD-A-B-T002'], '/tmp', links);
    expect(inv.args.slice(-2)).toEqual(['--filter', 'FullyQualifiedName=Ns.C.M2']);
    expect(buildInvocation(SAMPLE, r, ['DD-A-B-T009'], '/tmp', links).args.slice(-1)).toEqual(['TestId=DD-A-B-T009']);
  });
});

describe('api', async () => {
  const ctx = await createContext(SAMPLE, { watch: false });
  const app = createApp(ctx);
  const get = async (p: string) => {
    const res = await app.request(p);
    return { status: res.status, body: (await res.json()) as any };
  };

  it('lists documents', async () => {
    const { body } = await get('/api/tree');
    expect(body.docs.map((d: any) => d.kind).sort()).toEqual(['basic', 'detailed', 'requirements']);
  });

  it('returns a parsed document with matrices and links', async () => {
    const { body } = await get('/api/doc?path=docs/design/basic/order.md');
    expect(body.toc.every((t: any) => t.depth >= 2 && t.depth <= 3)).toBe(true);
    const m = body.matrices[0];
    expect(m.diagramKey).toBe('BD-ORDER-SCREEN');
    expect(m.cases.every((c: any) => !c.provisional)).toBe(true);
    const t2 = m.cases.find((c: any) => c.id === 'BD-ORDER-SCREEN-T002');
    expect(t2.links[0].runner).toBe('web');
  });

  it('computes As-Is/To-Be diffs', async () => {
    const { body } = await get('/api/doc?path=docs/design/requirements/order.md');
    const d = Object.values(body.diffs)[0] as any;
    expect(d.items.length).toBeGreaterThan(0);
  });

  it('resolves traces to the documents that define them', async () => {
    const detailed = await get('/api/doc?path=docs/design/detailed/order.md');
    expect(detailed.body.traces).toEqual([{ code: 'BD-ORDER', path: 'docs/design/basic/order.md' }]);
    const basic = await get('/api/doc?path=docs/design/basic/order.md');
    expect(basic.body.traces[0]).toEqual({ code: 'REQ-001', path: 'docs/design/requirements/order.md' });
  });

  it('resolves references and reports broken ones', async () => {
    const ok = await get(`/api/resolve?from=docs/design/basic/order.md&ref=${encodeURIComponent('../requirements/order.md#目的')}`);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.markdown).toMatch(/^## 目的/);
    const ng = await get(`/api/resolve?from=docs/design/basic/order.md&ref=${encodeURIComponent('../requirements/order.md#無い見出し')}`);
    expect(ng.status).toBe(404);
  });

  it('rejects path traversal', async () => {
    const res = await app.request('/raw/../../package.json');
    expect(res.status).toBe(404);
    const r2 = await get('/api/file?path=../../package.json');
    expect(r2.status).toBe(404);
  });

  it('lists test cases with links', async () => {
    const { body } = await get('/api/tests');
    const linked = body.cases.filter((c: any) => c.links.length);
    expect(linked.length).toBeGreaterThanOrEqual(12);
    expect(body.unknown).toEqual([]);
    const cs = body.cases.find((c: any) => c.id === 'DD-ORDER-STATUS-T001');
    expect(cs.links[0].test).toBe('OrderDomain.Tests.OrderStatusTests.新規作成するとDraft');
    expect(cs.level).toBe('unit');
    expect(body.cases.find((c: any) => c.id.startsWith('BD-')).level).toBe('integration');
  });
});

describe('テスト実行の状態（BD-VIEWER-RUN）', () => {
  it('[BD-VIEWER-RUN-X002] 実行中の実行要求は拒否する', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-runs-'));
    const config = parseConfig({ runners: [{ name: 'slow', type: 'command', cwd: '.', level: 'unit', command: 'node -e "setTimeout(()=>{},800)"' }] });
    const runs = new RunManager(repo, () => config);
    const ended = new Promise<RunRecord>((resolve) => runs.once('end', (_id: string, r: RunRecord) => resolve(r)));
    const first = runs.start({});
    expect(first.status).toBe('running');
    expect(() => runs.start({})).toThrow('進行中');
    const done = await ended;
    expect(done.id).toBe(first.id);
    expect(runs.active).toBeNull();
    await fs.rm(repo, { recursive: true, force: true });
  });
});
