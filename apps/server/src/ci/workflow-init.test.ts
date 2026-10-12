import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CiCommand } from './cli.ts';
import { initWorkflow, TEMPLATE_PATH, TemplateMissingError, WORKFLOW_PATH } from './workflow-init.ts';

let repo: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-init-'));
});
afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

const template = async () => (await fs.readFile(TEMPLATE_PATH, 'utf8')).replace(/\r\n/g, '\n');
const target = () => path.join(repo, WORKFLOW_PATH);

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, cmd: new CiCommand({ log: (l) => out.push(l), error: (l) => err.push(l), env: { runId: '' } as never }) };
}

describe('initWorkflow', () => {
  it('[DD-ACTWF-INIT-P001][DD-ACTWF-INIT-T001][DD-ACTWF-INIT-T002] 雛形を読めなければ TemplateMissingError（CLI は終了コード 1）', async () => {
    const missing = path.join(repo, 'none.yml');
    const e = await initWorkflow(repo, { template: missing }).catch((x) => x);
    expect(e).toBeInstanceOf(TemplateMissingError);
    expect(e.code).toBe('template-missing');
    expect(e.message).toBe(`ddv の雛形が見つかりません: ${missing}（ddv のインストールを確認してください）`);
    expect(existsSync(target())).toBe(false);
  });

  it('[DD-ACTWF-INIT-P002][DD-ACTWF-INIT-T003][DD-ACTWF-INIT-T004] ファイルがなければディレクトリを作って雛形を LF で書く', async () => {
    const r = await initWorkflow(repo);
    expect(r).toEqual({ status: 'created', path: '.github/workflows/ddv-tests.yml' });
    const text = await fs.readFile(target(), 'utf8');
    expect(text).toBe(await template());
    expect(text).not.toContain('\r');
    expect(text).toContain('ddv ci publish');
  });

  it('[DD-ACTWF-INIT-P003][DD-ACTWF-INIT-T005][DD-ACTWF-INIT-T006] 改行だけが違う既存ファイルは同一とみなし書き換えない', async () => {
    await fs.mkdir(path.dirname(target()), { recursive: true });
    const crlf = (await template()).replace(/\n/g, '\r\n');
    await fs.writeFile(target(), crlf);
    const r = await initWorkflow(repo);
    expect(r.status).toBe('unchanged');
    expect(await fs.readFile(target(), 'utf8')).toBe(crlf);
  });

  it('[DD-ACTWF-INIT-P004][DD-ACTWF-INIT-T007][DD-ACTWF-INIT-T008] 内容が違い force があれば上書きする', async () => {
    await fs.mkdir(path.dirname(target()), { recursive: true });
    await fs.writeFile(target(), 'name: mine\n');
    const r = await initWorkflow(repo, { force: true });
    expect(r.status).toBe('overwritten');
    expect(await fs.readFile(target(), 'utf8')).toBe(await template());
  });

  it('[DD-ACTWF-INIT-P005][DD-ACTWF-INIT-T009] 内容が違い force がなければ差分を返し、ファイルは変えない', async () => {
    await fs.mkdir(path.dirname(target()), { recursive: true });
    const mine = (await template()).replace("DDV_MAX_RUNS: '200'", "DDV_MAX_RUNS: '50'");
    await fs.writeFile(target(), mine);
    const r = await initWorkflow(repo);
    expect(r.status).toBe('differs');
    expect(r.diff).toMatch(/^-.*DDV_MAX_RUNS: '50'/m);
    expect(r.diff).toMatch(/^\+.*DDV_MAX_RUNS: '200'/m);
    expect(await fs.readFile(target(), 'utf8')).toBe(mine);
    const fake = { run: async () => ({ code: -1, stdout: '', stderr: 'spawn git ENOENT' }) };
    const r2 = await initWorkflow(repo, { git: fake });
    expect(r2.diff).toMatch(/^（差分を表示できません。行数 既存 \d+ \/ 雛形 \d+）$/);
  });

  it('[DD-ACTWF-INIT-P002][DD-ACTWF-INIT-P003][DD-ACTWF-INIT-P004][DD-ACTWF-INIT-P005] ddv actions init の出力と終了コード', async () => {
    const c = cli();
    expect(await c.cmd.main(['actions', 'init', '--repo', repo])).toBe(0);
    expect(c.out.pop()).toBe('配置しました: .github/workflows/ddv-tests.yml（コミットして既定ブランチへマージしてください）');
    expect(await c.cmd.main(['actions', 'init', '--repo', repo])).toBe(0);
    expect(c.out.pop()).toBe('変更なし: .github/workflows/ddv-tests.yml');
    await fs.writeFile(target(), 'name: mine\n');
    expect(await c.cmd.main(['actions', 'init', '--repo', repo])).toBe(1);
    expect(c.err.pop()).toBe('既存のファイルと内容が異なります。上書きするには --force を付けてください');
    expect(c.out.pop()).toContain('name: mine');
    expect(await c.cmd.main(['actions', 'init', '--repo', repo, '--force'])).toBe(0);
    expect(c.out.pop()).toBe('上書きしました: .github/workflows/ddv-tests.yml');
    expect(await c.cmd.main(['actions', 'init', '--repo', path.join(repo, 'nope')])).toBe(2);
    expect(c.err.pop()).toBe(`リポジトリが見つかりません: ${path.join(repo, 'nope')}`);
    expect(await c.cmd.main(['actions', 'bogus'])).toBe(2);
    expect(c.err.pop()).toMatch(/^不明なサブコマンド: actions bogus\n/);
    expect(await c.cmd.main(['ci', 'bogus'])).toBe(2);
    expect(c.err.pop()).toMatch(/^不明なサブコマンド: ci bogus\n/);
  });
});
