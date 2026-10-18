import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient, TokenResolver } from '@ddv/github';
import { parseConfig } from '@ddv/core';
import type { Scenario } from '@ddv/mock';
import { fakeGitHub, fakeGitHubState } from './github-fixture.ts';
import { PendingStore, ReviewService, type PendingComment, type PendingReview, type ReviewTarget } from './review.ts';
import { StatusCommitter } from './status-commit.ts';
import {
  hashOf,
  issuePath,
  READONLY_BRANCH,
  READONLY_RETIRED,
  rowKeyField,
  scenarioAfter,
  suggestionOf,
  tableDefs,
  TestDataError,
  TestDataService,
  type Reviewer,
  type TestDataBundle,
  type TestDataDraft,
  type TestDataWorkspace,
} from './testdata.ts';

const SAMPLE = path.resolve(__dirname, '../../../examples/sample-app/docs/mocks/order');
const MOCK = 'docs/mocks/order';
const SC = `${MOCK}/scenarios/BD-ORDER-SCREEN-P002.yaml`;
const FX = `${MOCK}/fixtures/default.yaml`;
const ID = 'BD-ORDER-SCREEN-P002';
const LOCAL: TestDataWorkspace = { kind: 'local' };
const config = parseConfig({ docsRoot: 'docs/design', mocksRoot: 'docs/mocks' });

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-td-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'ddv.config.yaml'), 'docsRoot: docs/design\nmocksRoot: docs/mocks\n');
  await fs.mkdir(path.join(dir, 'docs/design'), { recursive: true });
  await fs.cp(SAMPLE, path.join(dir, MOCK), { recursive: true });
  const read = (f: string) => fs.readFile(path.join(dir, f), 'utf8');
  const write = (f: string, t: string) => fs.writeFile(path.join(dir, f), t);
  return { dir, read, write };
}

function draftOf(b: TestDataBundle, edit: (d: TestDataDraft) => void = () => undefined): TestDataDraft {
  const d: TestDataDraft = {
    scenarioId: b.scenario.name,
    scenario: structuredClone(b.scenario.data),
    fixtures: Object.fromEntries(b.fixtures.map((f) => [f.name, structuredClone(f.data)])),
    base: Object.fromEntries([[b.scenario.path, b.scenario.hash], ...b.fixtures.map((f) => [f.path, f.hash])]),
    ...(b.headSha ? { headSha: b.headSha } : {}),
  };
  edit(d);
  return d;
}

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

async function rejects(p: Promise<unknown>): Promise<TestDataError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(TestDataError);
  return e as TestDataError;
}

describe('helpers', () => {
  it('issuePath / tableDefs / rowKeyField / hashOf', () => {
    expect(issuePath(['steps', 1, 'input', 'customer'])).toBe('steps[1].input.customer');
    expect(issuePath(['orders', 2, 'id'])).toBe('orders[2].id');
    expect(tableDefs('tables:\n  - orders\n  - { name: stock, key: sku }\n')).toEqual([
      { name: 'orders', key: 'id' },
      { name: 'stock', key: 'sku' },
    ]);
    expect(tableDefs(null)).toBeNull();
    expect(rowKeyField({ id: 1, a: 2 })).toBe('id');
    expect(rowKeyField({ sku: 'A', qty: 1 }, 'sku')).toBe('sku');
    expect(rowKeyField({ code: 'x', n: 1 })).toBe('code');
    expect(hashOf('abc')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('scenarioAfter does not add the defaults the file did not have', () => {
    const raw = { id: 'X', start: 'A', steps: [{ event: 'e', expect: { screen: 'A' } }] };
    const s: Scenario = { id: 'X', title: '', fixtures: [], start: 'A', steps: [{ event: 'e', input: {}, expect: { screen: 'A', text: {}, visible: [] } }] };
    expect(scenarioAfter(raw, s)).toEqual(raw);
  });
});

describe('TestDataService.load', () => {
  it('returns the scenario, its fixtures, the mock info and the editable flag (hash = SHA-256 first 16 hex)', async () => {
    const { dir, read } = await setup();
    const b = await new TestDataService(dir, config).load(ID, LOCAL);
    expect(b.scenario).toMatchObject({ name: ID, path: SC, hash: hashOf(await read(SC)) });
    expect(b.scenario.data.steps).toHaveLength(7);
    expect(b.fixtures).toEqual([{ name: 'default', path: FX, hash: hashOf(await read(FX)), data: parse(await read(FX)) }]);
    expect(b.availableFixtures).toEqual(['default']);
    expect(b.mock.tables).toEqual([
      { name: 'orders', key: 'id' },
      { name: 'stock', key: 'sku' },
      { name: 'drafts', key: 'id' },
    ]);
    expect(b.mock.testids).toContain('confirm-customer');
    expect(b.mock.fields.find((f) => f.key === 'quantity')?.kind).toBe('number');
    expect(b).toMatchObject({ editable: true, workspace: 'local' });
    expect(b.readonlyReason).toBeUndefined();
  });

  it('404 for an unknown scenario, 422 with issues for an unreadable one; branch and retired are read-only', async () => {
    const { dir, write, read } = await setup();
    const svc = new TestDataService(dir, config);
    expect((await rejects(svc.load('NOPE', LOCAL))).status).toBe(404);
    const text = await read(SC);
    await write(SC, text.replace('start: List', 'start: List\nbogus: 1'));
    const e = await rejects(svc.load(ID, LOCAL));
    expect(e.status).toBe(422);
    expect(e.extra.issues).toBeTruthy();
    await write(SC, text);
    expect(await svc.load(ID, { kind: 'branch' })).toMatchObject({ editable: false, readonlyReason: READONLY_BRANCH });
    await fs.mkdir(path.join(dir, MOCK, 'scenarios/_retired'));
    await fs.rename(path.join(dir, SC), path.join(dir, MOCK, 'scenarios/_retired/BD-ORDER-SCREEN-P002.yaml'));
    expect(await svc.load(ID, LOCAL)).toMatchObject({ editable: false, readonlyReason: READONLY_RETIRED, retired: true });
  });
});

describe('TestDataService.validate（VALIDATE）', () => {
  it('[DD-TDEDIT-VALIDATE-P001] [DD-TDEDIT-VALIDATE-T001] [DD-TDEDIT-VALIDATE-T002] schema errors stop the later stages', async () => {
    const { dir } = await setup();
    const svc = new TestDataService(dir, config);
    const b = await svc.load(ID, LOCAL);
    const r = await svc.validate(
      draftOf(b, (d) => {
        d.scenario.steps[3].expect!.count = { orders: -1 };
        d.scenario.steps[0].click = 'changed'; // generated: not reported in the same run
        (d.fixtures.default.orders[0] as Record<string, unknown>).customer = { x: 1 };
      }),
      LOCAL,
    );
    expect(codes(r)).toEqual(['schema', 'schema']);
    expect(r.errors[0]).toMatchObject({ file: SC, path: 'steps[3].expect.count.orders' });
    expect(r.errors[1]).toMatchObject({ file: FX, path: 'orders[0].customer' });
    expect(r.diff).toEqual([]);
  });

  it('[DD-TDEDIT-VALIDATE-P002] [DD-TDEDIT-VALIDATE-T003] [DD-TDEDIT-VALIDATE-T004] generated fields (event・click・expect.screen・expect.hidden), id, start and the step count cannot change', async () => {
    const { dir } = await setup();
    const svc = new TestDataService(dir, config);
    const b = await svc.load(ID, LOCAL);
    const r = await svc.validate(
      draftOf(b, (d) => {
        d.scenario.steps[0].event = 'x';
        d.scenario.steps[0].click = 'x';
        d.scenario.steps[1].expect!.screen = 'Done';
        d.scenario.steps[2].expect!.hidden = ['error'];
        d.scenario.start = 'Input';
        d.scenario.fixtures = ['nope']; // unknownFixture: a later stage
      }),
      LOCAL,
    );
    expect(codes(r).every((c) => c === 'generated')).toBe(true);
    expect(r.errors.map((e) => e.path)).toEqual(['start', 'steps[0].event', 'steps[0].click', 'steps[1].expect.screen', 'steps[2].expect.hidden']);
    const steps = await svc.validate(draftOf(b, (d) => d.scenario.steps.pop()), LOCAL);
    expect(steps.errors).toMatchObject([{ code: 'generated', path: 'steps' }]);
  });

  it('[DD-TDEDIT-VALIDATE-P003] [DD-TDEDIT-VALIDATE-T005] [DD-TDEDIT-VALIDATE-T006] fixtures that do not exist: 「fixtures が見つかりません：x」', async () => {
    const { dir } = await setup();
    const svc = new TestDataService(dir, config);
    const b = await svc.load(ID, LOCAL);
    const r = await svc.validate(draftOf(b, (d) => (d.scenario.fixtures = ['default', 'nope', 'gone'])), LOCAL);
    expect(r.errors).toEqual([
      { file: SC, path: 'fixtures[1]', code: 'unknownFixture', message: 'fixtures が見つかりません：nope' },
      { file: SC, path: 'fixtures[2]', code: 'unknownFixture', message: 'fixtures が見つかりません：gone' },
    ]);
  });

  it('[DD-TDEDIT-VALIDATE-P004] [DD-TDEDIT-VALIDATE-T007] [DD-TDEDIT-VALIDATE-T008] empty and duplicate row keys (key from api.yaml, default id)', async () => {
    const { dir } = await setup();
    const svc = new TestDataService(dir, config);
    const b = await svc.load(ID, LOCAL);
    const r = await svc.validate(
      draftOf(b, (d) => {
        d.fixtures.default.orders[1].id = 1;
        d.fixtures.default.stock.push({ sku: '', qty: 1 });
        d.fixtures.default.stock.push({ sku: 'A-100', qty: 2 });
      }),
      LOCAL,
    );
    expect(r.errors).toEqual([
      { file: FX, path: 'orders[1].id', code: 'duplicateKey', message: 'キー 1 が重複しています' },
      { file: FX, path: 'stock[2].sku', code: 'emptyKey', message: 'キーを入力してください' },
      { file: FX, path: 'stock[3].sku', code: 'duplicateKey', message: 'キー A-100 が重複しています' },
    ]);
  });

  it('[DD-TDEDIT-VALIDATE-P005] [DD-TDEDIT-VALIDATE-T009] [DD-TDEDIT-VALIDATE-T010] conflict when the file changed after load (PR: also the head)', async () => {
    const { dir, read, write } = await setup();
    const svc = new TestDataService(dir, config);
    const b = await svc.load(ID, LOCAL);
    await write(FX, `${await read(FX)}# edited\n`);
    const r = await svc.validate(draftOf(b), LOCAL);
    expect(r.errors).toMatchObject([{ code: 'conflict', file: FX }]);
    const target = { id: 'w', target: { owner: 'a', repo: 'b', pr: 1 }, headSha: 'h2', dir } as ReviewTarget;
    const pr = await svc.validate(draftOf(await svc.load(ID, LOCAL), (d) => (d.headSha = 'h1')), { kind: 'pr', target });
    expect(pr.errors).toMatchObject([{ code: 'conflict', message: 'PR の head が進みました。開き直してください' }]);
  });

  it('[DD-TDEDIT-VALIDATE-P006] [DD-TDEDIT-VALIDATE-T011] collects warnings (unknownElement・unknownTable・sharedFixture) and builds the diff', async () => {
    const { dir, read } = await setup();
    const svc = new TestDataService(dir, config);
    const b = await svc.load(ID, LOCAL);
    const r = await svc.validate(
      draftOf(b, (d) => {
        d.scenario.steps[1].input!.nothing = 'x';
        d.scenario.steps[1].expect!.text!['confirm-customer'] = '鈴木 一郎';
        d.fixtures.default.coupons = [{ id: 1, code: 'X' }];
      }),
      LOCAL,
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      { file: SC, path: 'steps[1].input.nothing', code: 'unknownElement', message: 'モックに data-testid="nothing" がありません' },
      { file: FX, path: 'coupons', code: 'unknownTable', message: 'テーブル coupons は api.yaml の tables にありません' },
      { file: FX, path: '', code: 'sharedFixture', message: 'default は他の 4 本のシナリオでも使われています' },
    ]);
    const lines = (await read(SC)).split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes('customer: 山田 太郎, sku: A-100')) + 1;
    expect(r.diff[0]).toEqual({
      path: SC,
      hunks: [
        { startLine: at, endLine: at, before: [lines[at - 1]], after: ['    input: { customer: 山田 太郎, sku: A-100, quantity: 1, nothing: x }'] },
        { startLine: at + 2, endLine: at + 2, before: [lines[at + 1]], after: ['    expect: { screen: Confirm, text: { confirm-customer: 鈴木 一郎 } }'] },
      ],
    });
    expect(r.diff[1].path).toBe(FX);
    expect(r.diff[1].hunks[0].after).toEqual(['coupons:', '  - id: 1', '    code: X']);
  });
});

function fakeReviewer(opts: { failAt?: number; placement?: 'line' | 'file' | 'body' } = {}) {
  const comments: PendingComment[] = [];
  const calls: Array<{ op: 'add' | 'update'; input: Record<string, any> }> = [];
  let n = 0;
  const r: Reviewer = {
    get: async () => ({ headSha: 'h1', comments }) as PendingReview,
    add: async (_ws, input) => {
      calls.push({ op: 'add', input: input as Record<string, any> });
      if (++n === opts.failAt) throw new Error('GitHub error');
      const a = input.anchor as any;
      const c = { id: `c${n}`, anchor: { ...a, lineText: [] }, body: input.body, suggestion: input.suggestion, state: 'Pending', placement: opts.placement ?? 'line', commitId: 'h1' } as PendingComment;
      comments.push(c);
      return c;
    },
    update: async (_ws, id, input) => {
      calls.push({ op: 'update', input: { id, ...input } });
      const c = comments.find((x) => x.id === id)!;
      Object.assign(c, { body: input.body, suggestion: input.suggestion });
      return c;
    },
  };
  return { r, calls, comments };
}

describe('suggestionOf（SUGGEST）', () => {
  const lines = ['a', 'b', 'c', 'd'];
  it('[DD-TDEDIT-SUGGEST-T006] a hunk with original lines → startLine..line of those lines', () => {
    expect(suggestionOf({ startLine: 2, endLine: 3, before: ['b', 'c'], after: ['B'] }, lines)).toEqual({ startLine: 2, line: 3, suggestion: 'B' });
  });
  it('[DD-TDEDIT-SUGGEST-T007] addition only → the previous line is included and first in the suggestion', () => {
    expect(suggestionOf({ startLine: 3, endLine: 2, before: [], after: ['x', 'y'] }, lines)).toEqual({ startLine: 2, line: 2, suggestion: 'b\nx\ny' });
    // at the top of the file there is no previous line: the next line is used
    expect(suggestionOf({ startLine: 1, endLine: 0, before: [], after: ['x'] }, lines)).toEqual({ startLine: 1, line: 1, suggestion: 'x\na' });
  });
  it('deletion only → the previous line is included (an empty suggestion cannot be posted)', () => {
    expect(suggestionOf({ startLine: 3, endLine: 3, before: ['c'], after: [] }, lines)).toEqual({ startLine: 2, line: 3, suggestion: 'b' });
  });
});

describe('TestDataService.save', () => {
  it('[BD-TDATA-SAVE-P004] [BD-TDATA-SAVE-T008] [BD-TDATA-SAVE-S007] local: rewrites only the changed parts of the YAML (temp file + rename)', async () => {
    const { dir, read } = await setup();
    const svc = new TestDataService(dir, config);
    const sc = await read(SC);
    const fx = await read(FX);
    const b = await svc.load(ID, LOCAL);
    const res = await svc.save(
      draftOf(b, (d) => {
        d.scenario.steps[1].input!.quantity = 2;
        d.fixtures.default.stock[0].qty = 5;
      }),
      LOCAL,
    );
    expect(res).toEqual({ mode: 'file', files: [SC, FX], comments: [] });
    expect(await read(SC)).toBe(sc.replace('sku: A-100, quantity: 1 }', 'sku: A-100, quantity: 2 }'));
    expect(await read(FX)).toBe(fx.replace('{ sku: A-100, qty: 10 }', '{ sku: A-100, qty: 5 }'));
    expect((await fs.readdir(path.join(dir, MOCK, 'fixtures'))).sort()).toEqual(['default.yaml']);
    expect((await rejects(svc.save(draftOf(await svc.load(ID, LOCAL)), LOCAL))).message).toBe('変更がありません');
  });

  it('[BD-TDATA-SAVE-P001] [BD-TDATA-SAVE-T001] [BD-TDATA-SAVE-T002] [BD-TDATA-SAVE-S001] a format error → 422, nothing written', async () => {
    const { dir, read } = await setup();
    const svc = new TestDataService(dir, config);
    const sc = await read(SC);
    const e = await rejects(svc.save(draftOf(await svc.load(ID, LOCAL), (d) => (d.scenario.steps[3].expect!.count = { orders: 1.5 })), LOCAL));
    expect(e.status).toBe(422);
    expect(e.extra.errors).toMatchObject([{ code: 'schema' }]);
    expect(await read(SC)).toBe(sc);
  });

  it('[BD-TDATA-SAVE-P002] [BD-TDATA-SAVE-T003] [BD-TDATA-SAVE-T004] [BD-TDATA-SAVE-S002] [BD-TDATA-SAVE-S003] duplicate keys → 422', async () => {
    const { dir, read } = await setup();
    const svc = new TestDataService(dir, config);
    const fx = await read(FX);
    const e = await rejects(svc.save(draftOf(await svc.load(ID, LOCAL), (d) => (d.fixtures.default.stock[1].sku = 'A-100')), LOCAL));
    expect(e.status).toBe(422);
    expect(e.extra.errors).toMatchObject([{ code: 'duplicateKey', path: 'stock[1].sku' }]);
    expect(await read(FX)).toBe(fx);
  });

  it('[BD-TDATA-SAVE-P003] [BD-TDATA-SAVE-T005] [BD-TDATA-SAVE-T006] [BD-TDATA-SAVE-S004] [BD-TDATA-SAVE-S005] the base hash differs → 409 conflict', async () => {
    const { dir, read, write } = await setup();
    const svc = new TestDataService(dir, config);
    const b = await svc.load(ID, LOCAL);
    const changed = (await read(SC)).replace('title:', '# x\ntitle:');
    await write(SC, changed);
    const e = await rejects(svc.save(draftOf(b, (d) => (d.scenario.steps[1].input!.quantity = 9)), LOCAL));
    expect(e.status).toBe(409);
    expect(e.code).toBe('conflict');
    expect(await read(SC)).toBe(changed);
  });

  it('403 readonly on a branch workspace and for a retired scenario', async () => {
    const { dir } = await setup();
    const svc = new TestDataService(dir, config);
    const b = await svc.load(ID, LOCAL);
    const e = await rejects(svc.save(draftOf(b, (d) => (d.scenario.steps[1].input!.quantity = 9)), { kind: 'branch' }));
    expect(e).toMatchObject({ status: 403, code: 'readonly', message: READONLY_BRANCH });
  });

  const target = (dir: string): ReviewTarget => ({ id: 'w', target: { owner: 'acme', repo: 'order-app', pr: 12 }, headSha: 'h1', mergeBase: 'm1', dir });

  it('[BD-TDATA-SAVE-P005] [BD-TDATA-SAVE-T007] [BD-TDATA-SAVE-T009] [BD-TDATA-SAVE-T010] [BD-TDATA-SAVE-S006] [BD-TDATA-SAVE-S008] [BD-TDATA-SAVE-S009] [DD-TDEDIT-SUGGEST-P001] [DD-TDEDIT-SUGGEST-T001] [DD-TDEDIT-SUGGEST-T002] [DD-TDEDIT-SUGGEST-T004] PR: one contiguous change → one suggestion for that range', async () => {
    const { dir, read } = await setup();
    const { r, calls } = fakeReviewer();
    const svc = new TestDataService(dir, config, r);
    const ws: TestDataWorkspace = { kind: 'pr', target: target(dir) };
    const sc = await read(SC);
    const res = await svc.save(draftOf(await svc.load(ID, ws), (d) => (d.scenario.steps[1].input!.quantity = 2)), ws);
    expect(res).toEqual({ mode: 'suggestion', files: [SC], comments: ['c1'] });
    const line = sc.split(/\r?\n/).findIndex((l) => l.includes('quantity: 1 }')) + 1;
    expect(calls).toEqual([
      {
        op: 'add',
        input: {
          anchor: { path: SC, side: 'RIGHT', startLine: line, line, element: { kind: 'testData', key: ID, label: `${ID}（シナリオ）` } },
          body: `テストデータ：${ID} の steps[1].input.quantity`,
          suggestion: '    input: { customer: 山田 太郎, sku: A-100, quantity: 2 }',
        },
      },
    ]);
    expect(await read(SC)).toBe(sc); // nothing written in a PR workspace
  });

  it('[DD-TDEDIT-SUGGEST-P002] one addition-only hunk → the previous line is included', async () => {
    const { dir, read } = await setup();
    const { r, calls } = fakeReviewer();
    const svc = new TestDataService(dir, config, r);
    const ws: TestDataWorkspace = { kind: 'pr', target: target(dir) };
    await svc.save(draftOf(await svc.load(ID, ws), (d) => d.fixtures.default.stock.push({ sku: 'C-300', qty: 1 })), ws);
    const lines = (await read(FX)).split(/\r?\n/);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.anchor).toMatchObject({ path: FX, startLine: 6, line: 6, element: { kind: 'testData', key: 'fixtures/default' } });
    expect(calls[0].input.suggestion).toBe(`${lines[5]}\n  - { sku: C-300, qty: 1 }`);
  });

  it('[BD-TDATA-SAVE-P006] [BD-TDATA-SAVE-T011] [BD-TDATA-SAVE-S010] [DD-TDEDIT-SUGGEST-P003] [DD-TDEDIT-SUGGEST-P004] [DD-TDEDIT-SUGGEST-T003] [DD-TDEDIT-SUGGEST-T005] PR: separate changes → one suggestion per hunk (replacement and addition-only)', async () => {
    const { dir } = await setup();
    const { r, calls } = fakeReviewer({ placement: 'body' });
    const svc = new TestDataService(dir, config, r);
    const ws: TestDataWorkspace = { kind: 'pr', target: target(dir) };
    const res = await svc.save(
      draftOf(await svc.load(ID, ws), (d) => {
        d.fixtures.default.orders[0].quantity = 5;
        d.fixtures.default.stock.push({ sku: 'C-300', qty: 1 });
      }),
      ws,
    );
    expect(calls.map((c) => [c.input.anchor.startLine, c.input.anchor.line])).toEqual([
      [2, 2],
      [6, 6],
    ]);
    expect(calls[0].input.suggestion).toBe('  - { id: 1, customer: 佐藤 花子, sku: A-100, quantity: 5, status: Submitted }');
    expect(calls[1].input.suggestion).toBe('  - { sku: B-200, qty: 3 }\n  - { sku: C-300, qty: 1 }');
    expect(res.comments).toEqual(['c1', 'c2']);
    expect(res.warnings).toEqual([`${FX} は PR の差分に無いため、suggestion はレビューの本文に入ります`]);
  });

  it('PR: the same range again updates the pending suggestion; a partial failure → 502 and the added ones stay', async () => {
    const { dir } = await setup();
    const fake = fakeReviewer();
    const svc = new TestDataService(dir, config, fake.r);
    const ws: TestDataWorkspace = { kind: 'pr', target: target(dir) };
    const b = await svc.load(ID, ws);
    await svc.save(draftOf(b, (d) => (d.scenario.steps[1].input!.quantity = 2)), ws);
    await svc.save(draftOf(b, (d) => ((d.scenario.steps[1].input!.quantity = 3), (d.comment = '数量を 3 に'))), ws);
    expect(fake.calls.map((c) => c.op)).toEqual(['add', 'update']);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]).toMatchObject({ body: '数量を 3 に', suggestion: '    input: { customer: 山田 太郎, sku: A-100, quantity: 3 }' });

    const failing = fakeReviewer({ failAt: 2 });
    const svc2 = new TestDataService(dir, config, failing.r);
    const e = await rejects(
      svc2.save(
        draftOf(b, (d) => {
          d.fixtures.default.orders[0].quantity = 5;
          d.fixtures.default.stock.push({ sku: 'C-300', qty: 1 });
        }),
        ws,
      ),
    );
    expect(e.status).toBe(502);
    expect(e.extra).toMatchObject({ comments: ['c1'], errors: [{ file: FX, path: 'L6-L6', message: 'GitHub error' }] });
    expect(failing.comments).toHaveLength(1);
  });

  it('PR with the real ReviewService: the testData anchor needs line numbers', async () => {
    const { dir } = await setup();
    const state = fakeGitHubState({ pulls: { 'acme/order-app': [{ number: 12, title: 't', headSha: 'h1', headRef: 'feature/x', baseRef: 'main' }] } });
    const f = fakeGitHub(state);
    const github = new GitHubClient(new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: state.token }, fetch: f }), { fetch: f });
    const review = new ReviewService({
      store: new PendingStore(path.join(dir, '.home')),
      github,
      git: { diff: async (_o, _r, _a, _b, paths) => (paths[0] === SC ? '@@ -1,40 +1,40 @@\n' : ''), show: async () => null },
      committer: new StatusCommitter(github),
      refresh: async () => undefined,
    });
    const ws: TestDataWorkspace = { kind: 'pr', target: target(dir) };
    const svc = new TestDataService(dir, config, review);
    const b = await svc.load(ID, ws);
    const res = await svc.save(draftOf(b, (d) => (d.scenario.steps[1].input!.quantity = 2)), ws);
    const pending = await review.get(ws.target!);
    expect(pending.comments).toHaveLength(1);
    expect(pending.comments[0]).toMatchObject({ id: res.comments[0], placement: 'line', anchor: { element: { kind: 'testData', key: ID } }, suggestion: '    input: { customer: 山田 太郎, sku: A-100, quantity: 2 }' });
    await expect(review.add(ws.target!, { anchor: { path: SC, element: { kind: 'testData', key: ID, label: ID } }, body: 'x' })).rejects.toThrow('行番号');
  });
});
