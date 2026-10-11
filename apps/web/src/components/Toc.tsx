import { useEffect, useMemo, useRef, useState } from 'react';
import { buildToc } from '@ddv/core';
import type { Heading } from '../api.ts';
import { useApp, useLocalStorage } from '../state.tsx';

export function Toc({ headings, scrollRoot }: { headings: Heading[]; scrollRoot: HTMLElement | null }) {
  const { config } = useApp();
  const [range, setRange] = useLocalStorage<[number, number] | null>('ddv.tocRange', null);
  const min = range?.[0] ?? config?.toc.minLevel ?? 2;
  const max = range?.[1] ?? config?.toc.maxLevel ?? 3;
  const toc = useMemo(() => buildToc(headings, min, max), [headings, min, max]);
  const [active, setActive] = useState('');
  const ignore = useRef(false);

  useEffect(() => {
    if (!scrollRoot) return;
    const onScroll = () => {
      if (ignore.current) return;
      const top = scrollRoot.getBoundingClientRect().top + 80;
      let cur = '';
      for (const t of toc) {
        const el = document.getElementById(t.slug);
        if (el && el.getBoundingClientRect().top <= top) cur = t.slug;
      }
      setActive(cur || toc[0]?.slug || '');
    };
    onScroll();
    scrollRoot.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollRoot.removeEventListener('scroll', onScroll);
  }, [scrollRoot, toc]);

  const levels = [1, 2, 3, 4, 5, 6];
  return (
    <nav className="toc" aria-label="目次" data-testid="toc">
      <div className="toc-head">
        <strong>目次</strong>
        <label>
          <select aria-label="目次の開始レベル" value={min} onChange={(e) => setRange([Number(e.target.value), Math.max(Number(e.target.value), max)])} data-testid="toc-min">
            {levels.map((l) => (
              <option key={l} value={l}>
                h{l}
              </option>
            ))}
          </select>
        </label>
        〜
        <label>
          <select aria-label="目次の終了レベル" value={max} onChange={(e) => setRange([Math.min(min, Number(e.target.value)), Number(e.target.value)])} data-testid="toc-max">
            {levels.map((l) => (
              <option key={l} value={l}>
                h{l}
              </option>
            ))}
          </select>
        </label>
        {range && (
          <button type="button" className="link" onClick={() => setRange(null)} title="設定ファイルの既定値に戻す">
            既定
          </button>
        )}
      </div>
      <ul>
        {toc.map((t) => (
          <li key={t.slug + t.line} className={`lv${t.depth - min}${active === t.slug ? ' is-active' : ''}`}>
            <a
              href={`#${t.slug}`}
              onClick={(e) => {
                e.preventDefault();
                ignore.current = true;
                setActive(t.slug);
                document.getElementById(t.slug)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                window.setTimeout(() => (ignore.current = false), 600);
              }}
            >
              {t.text}
            </a>
          </li>
        ))}
        {!toc.length && <li className="muted">該当する見出しがありません</li>}
      </ul>
    </nav>
  );
}
