import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseServeArgs, ServeArgsError } from './serve-args.ts';
import { OpenRequestError } from './workspaces.ts';

const cwd = path.resolve('/work/here');
const parse = (...argv: string[]) => parseServeArgs(['serve', ...argv], cwd, {});

describe('serve の引数（DD-LOCALF-SERVEARGS）', () => {
  it('[DD-LOCALF-SERVEARGS-P001] [DD-LOCALF-SERVEARGS-T001] [DD-LOCALF-SERVEARGS-T002] --repo と --last は同時に指定できない', () => {
    expect(() => parse('--repo', '.', '--last')).toThrow(new ServeArgsError('--repo と --last は同時に指定できません'));
    expect(() => parse('--last', '--repo', '.')).toThrow(ServeArgsError);
  });

  it('[DD-LOCALF-SERVEARGS-P002] [DD-LOCALF-SERVEARGS-T003] [DD-LOCALF-SERVEARGS-T004] --repo に値が無ければエラー', () => {
    expect(() => parse('--repo')).toThrow(new ServeArgsError('--repo にパスを指定してください'));
    expect(() => parse('--repo', '--open')).toThrow('--repo にパスを指定してください');
    expect(() => parse('--repo', '')).toThrow('--repo にパスを指定してください');
  });

  it('[DD-LOCALF-SERVEARGS-P003] [DD-LOCALF-SERVEARGS-T005] [DD-LOCALF-SERVEARGS-T009] [DD-LOCALF-SERVEARGS-T012] --repo はカレント基準の絶対パス、--open で openBrowser', () => {
    expect(parse('--repo', 'examples/app', '--open')).toMatchObject({ initial: 'repo', repo: path.resolve(cwd, 'examples/app'), openBrowser: true });
    expect(parse('--open', '--repo', path.resolve('/abs/repo'))).toMatchObject({ initial: 'repo', repo: path.resolve('/abs/repo'), openBrowser: true });
  });

  it('[DD-LOCALF-SERVEARGS-P004] [DD-LOCALF-SERVEARGS-T013] --repo だけなら openBrowser false', () => {
    expect(parse('--repo', '.')).toMatchObject({ initial: 'repo', repo: cwd, openBrowser: false });
  });

  it('[DD-LOCALF-SERVEARGS-P005] [DD-LOCALF-SERVEARGS-T006] [DD-LOCALF-SERVEARGS-T007] [DD-LOCALF-SERVEARGS-T010] --last --open', () => {
    const a = parse('--last', '--open');
    expect(a).toMatchObject({ initial: 'last', openBrowser: true });
    expect(a.repo).toBeUndefined();
  });

  it('[DD-LOCALF-SERVEARGS-P006] --last だけ', () => {
    expect(parse('--last')).toMatchObject({ initial: 'last', openBrowser: false });
  });

  it('[DD-LOCALF-SERVEARGS-P007] [DD-LOCALF-SERVEARGS-T008] [DD-LOCALF-SERVEARGS-T011] 引数無しは未選択（カレントは開かない）、--open は使える', () => {
    const a = parse('--open');
    expect(a).toMatchObject({ initial: 'none', openBrowser: true });
    expect(a.repo).toBeUndefined();
  });

  it('[DD-LOCALF-SERVEARGS-P008] 引数無しの既定値（ポート・ホスト）と既存のオプション', () => {
    expect(parse()).toEqual({ initial: 'none', openBrowser: false, port: 5178, host: '127.0.0.1', devOrigins: [] });
    expect(parseServeArgs(['serve'], cwd, { DDV_PORT: '6000', DDV_DEV_ORIGIN: 'http://localhost:5173' })).toMatchObject({ port: 6000, devOrigins: ['http://localhost:5173'] });
    expect(parse('--port', '7000', '--host', '0.0.0.0', '--dev-origin', 'http://localhost:5174')).toMatchObject({ port: 7000, host: '0.0.0.0', devOrigins: ['http://localhost:5174'] });
    expect(parse('--github', 'acme/app', '--pr', '3')).toMatchObject({ initial: 'none', github: { repo: 'acme/app', pr: '3' } });
    expect(() => parse('--github', 'acme')).toThrow(OpenRequestError);
  });
});
