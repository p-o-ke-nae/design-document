import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../backend/index.ts';
import type { ResolveResponse } from '../api.ts';
import { docHref, useApp } from '../state.tsx';
import { Markdown, useMd } from './Markdown.tsx';

const MAX_DEPTH = 3;

function useResolve(target: string, enabled: boolean) {
  const { basePath } = useMd();
  const { version } = useApp();
  const [res, setRes] = useState<ResolveResponse | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api
      .resolve(basePath, target)
      .then((r) => alive && setRes(r))
      .catch((e: Error) => alive && setRes({ ok: false, path: target, heading: '', error: e.message }));
    return () => {
      alive = false;
    };
  }, [basePath, target, enabled, version]);
  return res;
}

function hasText(n: ReactNode): boolean {
  if (typeof n === 'string') return n.trim().length > 0;
  if (Array.isArray(n)) return n.some(hasText);
  return Boolean(n);
}

function ResolvedBody({ res }: { res: ResolveResponse | null }) {
  const { depth } = useMd();
  if (!res) return <span className="muted">読み込み中…</span>;
  if (!res.ok) return <span className="error">参照切れ: {res.error}</span>;
  if (depth >= MAX_DEPTH) return <span className="muted">参照の入れ子が深すぎます</span>;
  return <Markdown text={res.markdown ?? ''} basePath={res.path} depth={depth + 1} />;
}

/** `:ref[path#heading]` — shows the referenced section in a popup (hover or click to pin). */
export function RefLink({ target, children }: { target: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const timer = useRef<number | undefined>(undefined);
  const wrap = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const res = useResolve(target, open);

  useEffect(() => {
    if (!pinned) return;
    const close = () => {
      setPinned(false);
      setOpen(false);
    };
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  const place = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 580)), top: r.bottom + 6 });
  };
  const enter = () => {
    window.clearTimeout(timer.current);
    place();
    timer.current = window.setTimeout(() => setOpen(true), 250);
  };
  const leave = () => {
    window.clearTimeout(timer.current);
    if (!pinned) timer.current = window.setTimeout(() => setOpen(false), 250);
  };

  return (
    <span className="ref" ref={wrap} onMouseEnter={enter} onMouseLeave={leave}>
      <button
        type="button"
        className={`ref-link${res && !res.ok ? ' is-broken' : ''}`}
        data-testid="ref-link"
        onClick={() => {
          place();
          setOpen(!pinned);
          setPinned(!pinned);
        }}
      >
        <span aria-hidden>🔗</span>
        {hasText(children) ? children : target}
      </button>
      {open &&
        createPortal(
          <div ref={popup} className="ref-popup" role="dialog" data-testid="ref-popup" style={{ left: pos.left, top: pos.top }} onMouseEnter={enter} onMouseLeave={leave}>
            <div className="ref-popup-head">
              <code>{target}</code>
              {pinned && <span className="chip">固定中（Escで閉じる）</span>}
              {res?.ok && (
                <a href={docHref(res.path, res.slug)} onClick={() => setOpen(false)}>
                  開く ↗
                </a>
              )}
            </div>
            <div className="ref-popup-body">
              <ResolvedBody res={res} />
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

/** `::embed[path#heading]` — renders the referenced section inline (single source of truth). */
export function Embed({ target }: { target: string }) {
  const res = useResolve(target, true);
  return (
    <div className={`embed${res && !res.ok ? ' is-broken' : ''}`} data-testid="embed">
      <div className="embed-head">
        <span>参照: </span>
        {res?.ok ? <a href={docHref(res.path, res.slug)}>{target}</a> : <code>{target}</code>}
      </div>
      <div className="embed-body">
        <ResolvedBody res={res} />
      </div>
    </div>
  );
}
