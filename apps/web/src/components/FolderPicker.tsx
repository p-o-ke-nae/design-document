import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, localApi, type DirList, type RecentFolder } from '../api.ts';
import { useWorkspaces } from './Workspace.tsx';

const ROOTS_LABEL = 'ドライブ・ホーム';
const EMPTY_MESSAGE = 'パスを入力してください';

/** Parent folder of an absolute path (Windows or POSIX); undefined at a root. */
export function parentOf(p: string): string | undefined {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return undefined;
  const parent = s.slice(0, i);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent === '' ? '/' : parent;
}

/** `M/D HH:mm` */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 「フォルダの選択」（`#/folder`） */
export function FolderPicker() {
  const { reload } = useWorkspaces();
  const [path, setPath] = useState('');
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const [dirs, setDirs] = useState<DirList | null>(null);
  const [dirsError, setDirsError] = useState('');
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const seq = useRef(0);

  const load = useCallback(async (p?: string) => {
    const n = ++seq.current;
    try {
      const d = await localApi.dirs(p);
      if (n !== seq.current) return;
      setDirs(d);
      setDirsError('');
    } catch (e) {
      if (n !== seq.current) return;
      setDirsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshRecent = useCallback(async () => {
    const info = await localApi.info().catch(() => null);
    if (info) setRecent(info.recent);
    return info;
  }, []);

  useEffect(() => {
    void (async () => {
      const info = await refreshRecent();
      const start = info?.root ?? (info?.recent[0] ? parentOf(info.recent[0].path) : undefined);
      await load(start);
    })();
  }, [load, refreshRecent]);

  const open = async (input: string) => {
    const p = input.trim();
    setPath(input);
    if (!p) {
      setOpenError(EMPTY_MESSAGE);
      return;
    }
    setOpenError('');
    setOpening(true);
    try {
      await localApi.open(p);
      await reload();
      location.hash = '#/';
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && e.body?.removed === true) void refreshRecent();
    } finally {
      setOpening(false);
    }
  };

  const remove = async (p: string) => {
    try {
      setRecent((await localApi.removeRecent(p)).recent);
    } catch {
      void refreshRecent();
    }
  };

  return (
    <div className="folder-picker">
      <h2>作業フォルダを開く</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void open(path);
        }}
      >
        <label htmlFor="folder-path">パス</label>
        <input id="folder-path" className="path" data-testid="path" maxLength={400} value={path} onChange={(e) => setPath(e.target.value)} />
        <button type="submit" className="primary" disabled={opening} data-testid="open">
          開く
        </button>
      </form>
      {openError && (
        <p className="error" data-testid="open-error">
          {openError}
        </p>
      )}
      <div className="row">
        <h3 data-testid="dirs-current">{dirs?.path ?? ROOTS_LABEL}</h3>
        <button type="button" disabled={!dirs || dirs.path === null} onClick={() => void load(dirs?.parent ?? undefined)} data-testid="dirs-up">
          上の階層へ
        </button>
        <button type="button" onClick={() => void load()} data-testid="dirs-roots">
          {ROOTS_LABEL}
        </button>
      </div>
      {dirsError && (
        <p className="error" data-testid="dirs-error">
          {dirsError}
        </p>
      )}
      <ul className="dirs" data-testid="dirs">
        {dirs?.entries.map((d) => (
          <li
            key={d.path}
            title={d.path}
            onClick={() => {
              setPath(d.path);
              void load(d.path);
            }}
            onDoubleClick={() => void open(d.path)}
          >
            {d.kind === 'dir' ? '📁' : d.kind === 'home' ? '🏠' : '💽'} {d.name}
            {d.hasConfig && <span className="cfg">ddv.config.yaml あり</span>}
          </li>
        ))}
        {dirs?.truncated && <li className="muted">500 件まで表示しています。パスを入力してください</li>}
      </ul>
      <h3>最近開いたフォルダ</h3>
      <ul className="recent" data-testid="recent">
        {recent.map((r) => (
          <li key={r.path}>
            <span className="recent-path" title={r.path} onClick={() => setPath(r.path)} onDoubleClick={() => void open(r.path)}>
              {r.path}
            </span>{' '}
            <span className="muted">{shortDate(r.openedAt)}</span>
            {r.hasConfig && <span className="cfg">ddv.config.yaml あり</span>}{' '}
            <button type="button" title="一覧から消す" onClick={() => void remove(r.path)} data-testid="recent-remove">
              削除
            </button>
          </li>
        ))}
      </ul>
      <p className="muted">一覧・最近開いたフォルダを選ぶとパスに入ります。</p>
    </div>
  );
}
