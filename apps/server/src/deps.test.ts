import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, type DdvConfig } from '@ddv/core';
import { createApp, createContext, type ServerContext } from './app.ts';
import { checkDeps, installCommand } from './deps.ts';

const tmps: string[] = [];
const ctxs: ServerContext[] = [];

afterEach(async () => {
  ctxs.splice(0).forEach((c) => c.close());
  for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-deps-'));
  tmps.push(root);
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  return root;
}

const cfg = (runners: Array<{ name: string; type: string; cwd?: string }>): DdvConfig => parseConfig({ runners });
const PKG = '{"name":"x","version":"1.0.0","private":true}';
const LOCK = '{"name":"x","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"x","version":"1.0.0"}}}';
// Built at runtime so the repository's own test-id scan does not pick it up.
const FIXTURE_ID = ['DD', 'A', 'B', 'T001'].join('-');

describe('checkDeps', () => {
  it('[DD-WSPACE-DEPS-P001] [DD-WSPACE-DEPS-T001] [DD-WSPACE-DEPS-T002] Node 系ランナーが無ければ導入不要', async () => {
    const root = await repo({ 'package.json': PKG });
    expect(checkDeps(root, cfg([{ name: 'net', type: 'dotnet' }, { name: 'sh', type: 'command' }]))).toEqual({ needed: false, targets: [], problems: [] });
  });

  it('[DD-WSPACE-DEPS-P002] [DD-WSPACE-DEPS-T003] [DD-WSPACE-DEPS-T004] ランナーのパッケージを解決できれば導入不要', async () => {
    const root = await repo({ 'package.json': PKG, 'node_modules/vitest/package.json': '{"name":"vitest","version":"0.0.0"}' });
    expect(checkDeps(root, cfg([{ name: 'unit', type: 'vitest' }])).needed).toBe(false);
  });

  it('[DD-WSPACE-DEPS-P003] [DD-WSPACE-DEPS-T005] [DD-WSPACE-DEPS-T006] pnpm-lock.yaml なら pnpm install --frozen-lockfile', async () => {
    const root = await repo({ 'package.json': PKG, 'pnpm-lock.yaml': '' });
    expect(checkDeps(root, cfg([{ name: 'unit', type: 'vitest' }]))).toEqual({
      needed: true,
      targets: [{ dir: '.', lockfile: 'pnpm-lock.yaml', manager: 'pnpm', command: 'pnpm', args: ['install', '--frozen-lockfile'], runners: ['unit'], missing: ['vitest'] }],
      problems: [],
    });
  });

  it('[DD-WSPACE-DEPS-P004] [DD-WSPACE-DEPS-T007] [DD-WSPACE-DEPS-T008] yarn.lock と .yarnrc.yml なら yarn install --immutable', async () => {
    const root = await repo({ 'package.json': PKG, 'yarn.lock': '', '.yarnrc.yml': '' });
    expect(checkDeps(root, cfg([{ name: 'e2e', type: 'playwright' }])).targets).toMatchObject([{ manager: 'yarn', args: ['install', '--immutable'], missing: ['@playwright/test'] }]);
  });

  it('[DD-WSPACE-DEPS-P005] [DD-WSPACE-DEPS-T009] yarn.lock だけなら yarn install --frozen-lockfile', async () => {
    const root = await repo({ 'package.json': PKG, 'yarn.lock': '' });
    expect(checkDeps(root, cfg([{ name: 'unit', type: 'vitest' }])).targets).toMatchObject([{ manager: 'yarn', args: ['install', '--frozen-lockfile'] }]);
  });

  it('[DD-WSPACE-DEPS-P006] [DD-WSPACE-DEPS-T010] bun.lock なら bun install --frozen-lockfile', async () => {
    const root = await repo({ 'package.json': PKG, 'bun.lockb': '' });
    expect(checkDeps(root, cfg([{ name: 'unit', type: 'vitest' }])).targets).toMatchObject([{ manager: 'bun', command: 'bun', args: ['install', '--frozen-lockfile'] }]);
  });

  it('[DD-WSPACE-DEPS-P007] [DD-WSPACE-DEPS-T011] package-lock.json なら npm ci。cwd が下の階層でもルートのロックファイルで、同じ導入先はまとめる', async () => {
    const root = await repo({ 'package.json': PKG, 'package-lock.json': LOCK, 'apps/web/package.json': PKG });
    const st = checkDeps(root, cfg([{ name: 'unit', type: 'vitest', cwd: 'apps/web' }, { name: 'e2e', type: 'playwright' }]));
    expect(st.targets).toEqual([{ dir: '.', lockfile: 'package-lock.json', manager: 'npm', command: 'npm', args: ['ci'], runners: ['unit', 'e2e'], missing: ['vitest', '@playwright/test'] }]);
    expect(installCommand('npm', 'npm-shrinkwrap.json', root)).toEqual({ command: 'npm', args: ['ci'] });
  });

  it('[DD-WSPACE-DEPS-P008] [DD-WSPACE-DEPS-T012] [DD-WSPACE-DEPS-T013] ロックファイルが無ければ近い package.json で npm install', async () => {
    const root = await repo({ 'apps/web/package.json': PKG });
    expect(checkDeps(root, cfg([{ name: 'unit', type: 'vitest', cwd: 'apps/web' }])).targets).toEqual([
      { dir: 'apps/web', lockfile: undefined, manager: 'npm', command: 'npm', args: ['install'], runners: ['unit'], missing: ['vitest'] },
    ]);
  });

  it('[DD-WSPACE-DEPS-P009] [DD-WSPACE-DEPS-T014] package.json も無ければ導入できない理由を返す', async () => {
    const root = await repo({ 'README.md': '' });
    expect(checkDeps(root, cfg([{ name: 'unit', type: 'vitest' }]))).toEqual({ needed: false, targets: [], problems: [expect.stringContaining('unit: vitest が見つからず')] });
  });
});

describe('依存の導入の API', () => {
  async function app(checkDepsOn: boolean) {
    const root = await repo({
      'ddv.config.yaml': 'docsRoot: docs\nrunners:\n  - name: unit\n    type: vitest\n',
      'package.json': PKG,
      'package-lock.json': LOCK,
      'a.test.ts': `it('[${FIXTURE_ID}] x', () => {});\n`,
    });
    const ctx = await createContext(root, { watch: false });
    ctx.checkDeps = checkDepsOn;
    ctxs.push(ctx);
    const a = createApp(ctx);
    const post = (p: string, body: unknown = {}) => a.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const end = (id: string) =>
      new Promise<void>((resolve) => {
        const on = (rid: string) => rid === id && (ctx.runs.off('end', on), resolve());
        ctx.runs.on('end', on);
      });
    return { root, ctx, a, post, end };
  }

  it('GitHub のワークスペースは依存が無ければ tests/run を 409 deps-missing にする', async () => {
    const { a, post } = await app(true);
    expect(await (await a.request('/api/deps')).json()).toMatchObject({ needed: true, targets: [{ dir: '.', command: 'npm', args: ['ci'], missing: ['vitest'] }] });
    const res = await post('/api/tests/run', {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'deps-missing', deps: { needed: true, targets: [{ runners: ['unit'] }] } });
  });

  it('手元のワークスペースは確認せず実行し、ランナーを起動できなければテストIDの結果に理由を出す', async () => {
    const { ctx, post, end } = await app(false);
    const res = await post('/api/tests/run', { ids: [FIXTURE_ID] });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    if (ctx.runs.runs.get(id)!.status === 'running') await end(id);
    const run = ctx.runs.runs.get(id)!;
    expect(run.status).toBe('error');
    expect(run.results[FIXTURE_ID]).toMatchObject({ status: 'error', runner: 'unit', message: expect.stringMatching(/ランナー unit を起動できませんでした: vitest が見つかりません/) });
  });

  it('deps/install はロックファイルのコマンドを実行し、導入後も不足があれば error', async () => {
    const { ctx, post, end } = await app(true);
    const res = await post('/api/deps/install');
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect(await (await post('/api/tests/run', {})).json()).toMatchObject({ code: 'deps-installing' });
    if (ctx.runs.runs.get(runId)!.status === 'running') await end(runId);
    const run = ctx.runs.runs.get(runId)!;
    expect(run.log[0]).toBe('$ npm ci  (.)');
    expect(run.log.join('\n')).toContain('導入後も vitest が見つかりません');
    expect(run.status).toBe('error');
  }, 120_000);

  it('deps/install で導入できれば passed（ロックファイル無し → npm install）', async () => {
    const root = await repo({
      'ddv.config.yaml': 'docsRoot: docs\nrunners:\n  - name: unit\n    type: vitest\n',
      'package.json': '{"name":"x","version":"1.0.0","private":true,"devDependencies":{"vitest":"file:fake-vitest"}}',
      'fake-vitest/package.json': '{"name":"vitest","version":"0.0.0"}',
    });
    const ctx = await createContext(root, { watch: false });
    ctx.checkDeps = true;
    ctxs.push(ctx);
    const a = createApp(ctx);
    const res = await a.request('/api/deps/install', { method: 'POST' });
    const { runId } = (await res.json()) as { runId: string };
    if (ctx.runs.runs.get(runId)!.status === 'running')
      await new Promise<void>((resolve) => ctx.runs.on('end', (rid: string) => rid === runId && resolve()));
    const run = ctx.runs.runs.get(runId)!;
    expect(run.log[0]).toBe('$ npm install  (.)');
    expect(run.status).toBe('passed');
    expect(await (await a.request('/api/deps')).json()).toMatchObject({ needed: false });
  }, 120_000);
});
