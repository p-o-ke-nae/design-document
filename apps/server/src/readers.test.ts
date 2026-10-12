import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsRepoReader } from './fs-reader.ts';
import { GitRevReader } from './git-reader.ts';
import { NoFolderError, ReaderFactory } from './readers.ts';
import { WorkspaceError, type Workspace } from './workspaces.ts';

type Ws = Pick<Workspace, 'id' | 'state' | 'dir' | 'generation' | 'mergeBase' | 'target'>;

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-readers-'));
  await fs.mkdir(path.join(tmp, 'local'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'wt'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'local', 'README.md'), 'local\n');
  await fs.writeFile(path.join(tmp, 'wt', 'README.md'), 'head\n');
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const ws = (over: Partial<Ws> = {}): Ws => ({ id: 'o-r-pr-1', state: 'Ready', dir: path.join(tmp, 'wt'), generation: 1, mergeBase: 'b'.repeat(40), target: { id: 'o-r-pr-1', name: 'o/r#1', owner: 'o', repo: 'r', pr: 1 } as Ws['target'], ...over });
const git = { show: async (_o: string, _r: string, sha: string, file: string) => (file === 'README.md' ? `base@${sha.slice(0, 4)}\n` : null) };
const factory = (items: Ws[], local: ConstructorParameters<typeof ReaderFactory>[0]['local'] = null) =>
  new ReaderFactory({ workspaces: { get: (id) => items.find((w) => w.id === id) }, git, local });

const thrown = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('did not throw');
};

describe('ReaderFactory.forWorkspace (DD-SVC-READERSEL)', () => {
  it('[DD-SVC-READERSEL-P008] [DD-SVC-READERSEL-T001] [DD-SVC-READERSEL-T014] [DD-SVC-READERSEL-T015] wsId が空で手元のフォルダが開かれていなければ LocalError 409 no-folder', () => {
    for (const local of [null, { ctx: null, generation: 0 }, () => null]) {
      const e = thrown(() => factory([], local).forWorkspace('', 'RIGHT'));
      expect(e).toBeInstanceOf(NoFolderError);
      expect(e).toMatchObject({ status: 409, code: 'no-folder', message: 'フォルダが開かれていません' });
    }
  });

  it('[DD-SVC-READERSEL-P009] [DD-SVC-READERSEL-T014] [DD-SVC-READERSEL-T016] [DD-SVC-READERSEL-T003] 手元の RIGHT は手元のフォルダの FsRepoReader（generation ごとに作り直す）', async () => {
    const local = { ctx: { repoRoot: path.join(tmp, 'local') }, generation: 0 };
    const f = factory([], () => local);
    const r = f.forWorkspace('', 'RIGHT');
    expect(r).toBeInstanceOf(FsRepoReader);
    expect(await r!.readText('README.md')).toBe('local\n');
    expect(f.forWorkspace('', 'RIGHT')).toBe(r);
    local.generation = 1;
    expect(f.forWorkspace('', 'RIGHT')).not.toBe(r);
  });

  it('[DD-SVC-READERSEL-P010] [DD-SVC-READERSEL-T016] [DD-SVC-READERSEL-T004] 手元の LEFT は null（手元には base が無い）', () => {
    expect(factory([], { ctx: { repoRoot: path.join(tmp, 'local') }, generation: 0 }).forWorkspace('', 'LEFT')).toBeNull();
  });

  it('[DD-SVC-READERSEL-P003] [DD-SVC-READERSEL-T005] [DD-SVC-READERSEL-T006] ワークスペースが無ければ WorkspaceError 404 not-found（WorkspaceManager.context と同じ文言）', () => {
    const e = thrown(() => factory([ws()]).forWorkspace('x-y-pr-9', 'RIGHT'));
    expect(e).toBeInstanceOf(WorkspaceError);
    expect(e).toMatchObject({ status: 404, code: 'not-found', message: 'ワークスペースがありません: x-y-pr-9' });
  });

  it('[DD-SVC-READERSEL-P004] [DD-SVC-READERSEL-T007] [DD-SVC-READERSEL-T008] state が Ready・Stale でなければ WorkspaceError 409 not-ready', () => {
    for (const state of ['None', 'Fetching', 'Error'] as const) {
      const e = thrown(() => factory([ws({ state })]).forWorkspace('o-r-pr-1', 'LEFT'));
      expect(e).toBeInstanceOf(WorkspaceError);
      expect(e).toMatchObject({ status: 409, code: 'not-ready', message: `ワークスペースの準備ができていません（${state}）` });
    }
  });

  it('[DD-SVC-READERSEL-P005] [DD-SVC-READERSEL-T009] [DD-SVC-READERSEL-T010] RIGHT は worktree の FsRepoReader（generation ごとに 1 つ）', async () => {
    const w = ws({ state: 'Stale' });
    const f = factory([w]);
    const r = f.forWorkspace(w.id, 'RIGHT');
    expect(r).toBeInstanceOf(FsRepoReader);
    expect(r!.revision).toMatch(/^worktree:/);
    expect(await r!.readText('README.md')).toBe('head\n');
    expect(f.forWorkspace(w.id, 'RIGHT')).toBe(r);
    w.generation = 2;
    const r2 = f.forWorkspace(w.id, 'RIGHT');
    expect(r2).not.toBe(r);
    expect(f.forWorkspace(w.id, 'RIGHT')).toBe(r2);
  });

  it('[DD-SVC-READERSEL-P006] [DD-SVC-READERSEL-T009] [DD-SVC-READERSEL-T011] [DD-SVC-READERSEL-T012] LEFT で mergeBase があれば GitRevReader（revision = mergeBase）', async () => {
    const w = ws();
    const r = factory([w]).forWorkspace(w.id, 'LEFT');
    expect(r).toBeInstanceOf(GitRevReader);
    expect(r!.revision).toBe(w.mergeBase);
    expect(await r!.readText('README.md')).toBe('base@bbbb\n');
    expect(await r!.tryReadText('missing.md')).toBeNull();
  });

  it('[DD-SVC-READERSEL-P007] [DD-SVC-READERSEL-T011] [DD-SVC-READERSEL-T013] LEFT で mergeBase が無ければ null', () => {
    expect(factory([ws({ mergeBase: undefined })]).forWorkspace('o-r-pr-1', 'LEFT')).toBeNull();
  });
});