import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '@ddv/core';
import { initMocks, SCENARIO_SPEC_TEXT } from './init.ts';
import { mockRuntimeHeader, MOCK_VERSION } from './version.ts';

let dir: string;
let repo: string;
let runtimeFile: string;
const config = parseConfig({ docsRoot: 'docs', mocksRoot: 'docs/mocks' });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-init-'));
  repo = path.join(dir, 'repo');
  await fs.mkdir(repo);
  runtimeFile = path.join(dir, 'mock-runtime.js');
  await fs.writeFile(runtimeFile, `${mockRuntimeHeader()}\nexport const a = 1;\n`);
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

describe('initMocks', () => {
  it('runtime と spec を配置し、同じ内容なら何もしない', async () => {
    expect(await initMocks(repo, config, { runtimeFile })).toMatchObject({ runtime: 'created', spec: 'created', runtimePath: 'docs/mocks/_ddv/mock-runtime.js' });
    expect(await fs.readFile(path.join(repo, 'docs/mocks/_ddv/mock-runtime.js'), 'utf8')).toBe(await fs.readFile(runtimeFile, 'utf8'));
    expect(await fs.readFile(path.join(repo, 'e2e/ddv-scenarios.spec.ts'), 'utf8')).toBe(SCENARIO_SPEC_TEXT);
    expect(await initMocks(repo, config, { runtimeFile })).toMatchObject({ runtime: 'unchanged', spec: 'unchanged' });
  });

  it('版や内容が違えば runtime を更新し、既存の spec は変えない', async () => {
    await fs.writeFile(path.join(repo, 'docs/mocks/_ddv/mock-runtime.js'), '// @ddv/mock-runtime 0.0.1\nold\n');
    await fs.writeFile(path.join(repo, 'e2e/ddv-scenarios.spec.ts'), '// custom\n');
    expect(await initMocks(repo, config, { runtimeFile })).toMatchObject({ runtime: 'updated', spec: 'unchanged' });
    expect((await fs.readFile(path.join(repo, 'docs/mocks/_ddv/mock-runtime.js'), 'utf8')).split('\n')[0]).toBe(`// @ddv/mock-runtime ${MOCK_VERSION}`);
    expect(await fs.readFile(path.join(repo, 'e2e/ddv-scenarios.spec.ts'), 'utf8')).toBe('// custom\n');
  });

  it('ビルド成果物がない・版が違うときは作り直しを促す', async () => {
    await expect(initMocks(repo, config, { runtimeFile: path.join(dir, 'none.js') })).rejects.toThrow('npm run build -w @ddv/mock-runtime');
    const stale = path.join(dir, 'stale.js');
    await fs.writeFile(stale, '// @ddv/mock-runtime 0.0.0\n');
    await expect(initMocks(repo, config, { runtimeFile: stale })).rejects.toThrow('版');
  });
});
