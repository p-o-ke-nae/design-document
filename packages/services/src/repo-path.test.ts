import { describe, expect, it } from 'vitest';
import { RepoReadError } from './errors.ts';
import { isUnder, normalizeRepoPath, RepoPathError } from './repo-path.ts';

const rejects = (rel: string) => {
  let err: unknown;
  try {
    normalizeRepoPath(rel);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RepoPathError);
  expect(err).toBeInstanceOf(RepoReadError);
  expect(err).toMatchObject({ status: 404, code: 'not-found', message: `path escapes repository: ${rel}` });
};

describe('normalizeRepoPath (DD-SVC-REPOPATH)', () => {
  it('[DD-SVC-REPOPATH-P001] [DD-SVC-REPOPATH-T001] [DD-SVC-REPOPATH-T002] NUL 文字を含むパスは RepoPathError（404 not-found）', () => {
    rejects('docs/a\u0000.md');
    rejects('\u0000');
  });

  it('[DD-SVC-REPOPATH-P002] [DD-SVC-REPOPATH-T003] [DD-SVC-REPOPATH-T004] [DD-SVC-REPOPATH-T005] ドライブ名で始まるパスは（バックスラッシュ・先頭スラッシュの変換の後でも）RepoPathError', () => {
    rejects('C:/x');
    rejects('c:\\x\\y.md');
    rejects('/D:/x');
    rejects('\\C:\\x');
  });

  it('[DD-SVC-REPOPATH-P003] [DD-SVC-REPOPATH-T006] [DD-SVC-REPOPATH-T007] [DD-SVC-REPOPATH-T008] .. で根より上に出るパスは RepoPathError', () => {
    rejects('../x');
    rejects('docs/../../x');
    rejects('./..');
    rejects('a/b/../../../c');
  });

  it('[DD-SVC-REPOPATH-P004] [DD-SVC-REPOPATH-T009] [DD-SVC-REPOPATH-T011] [DD-SVC-REPOPATH-T012] .. で根の内側に収まり、結果が空なら空文字（リポジトリの根）', () => {
    expect(normalizeRepoPath('docs/..')).toBe('');
    expect(normalizeRepoPath('a/b/../..')).toBe('');
    expect(normalizeRepoPath('/docs/./../')).toBe('');
  });

  it('[DD-SVC-REPOPATH-P005] [DD-SVC-REPOPATH-T009] [DD-SVC-REPOPATH-T011] [DD-SVC-REPOPATH-T013] .. で直前の段を取り除き、正規化したパスを返す', () => {
    expect(normalizeRepoPath('docs/../README.md')).toBe('README.md');
    expect(normalizeRepoPath('docs/a/../b/c.md')).toBe('docs/b/c.md');
    expect(normalizeRepoPath('docs\\x\\..\\a.md')).toBe('docs/a.md');
  });

  it('[DD-SVC-REPOPATH-P006] [DD-SVC-REPOPATH-T010] [DD-SVC-REPOPATH-T012] .. が無く、空と . の段を除いた結果が空なら空文字', () => {
    expect(normalizeRepoPath('')).toBe('');
    expect(normalizeRepoPath('/')).toBe('');
    expect(normalizeRepoPath('./')).toBe('');
    expect(normalizeRepoPath('\\.\\')).toBe('');
  });

  it('[DD-SVC-REPOPATH-P007] [DD-SVC-REPOPATH-T010] [DD-SVC-REPOPATH-T013] .. が無いパスはバックスラッシュ・先頭スラッシュ・空と . の段を正規化する', () => {
    expect(normalizeRepoPath('docs\\a.md')).toBe('docs/a.md');
    expect(normalizeRepoPath('/docs/./a.md')).toBe('docs/a.md');
    expect(normalizeRepoPath('//docs//a.md/')).toBe('docs/a.md');
    expect(normalizeRepoPath('.ddv/traces/r/x.json')).toBe('.ddv/traces/r/x.json');
    expect(normalizeRepoPath('a..b/c')).toBe('a..b/c');
  });

  it('isUnder: 根・自身・配下', () => {
    expect(isUnder('docs/a.md', '')).toBe(true);
    expect(isUnder('docs', 'docs')).toBe(true);
    expect(isUnder('docs/a.md', 'docs')).toBe(true);
    expect(isUnder('docsx/a.md', 'docs')).toBe(false);
  });
});