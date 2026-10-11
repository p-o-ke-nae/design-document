import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import mermaid from 'mermaid';
import type { Graph } from '../api.ts';
import { applyDiff, applyPairHighlight, applyPathHighlight, clearMarks, clearPairHighlight, targetFromElement, type HoverTarget } from '../highlight.ts';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', fontFamily: 'inherit' });

let seq = 0;

export interface MermaidViewProps {
  code: string;
  graph?: Graph;
  highlight?: { edges: number[]; nodes: string[] } | null;
  diff?: { nodes: Record<string, string>; edges: Record<number, string> } | null;
  toolbar?: ReactNode;
  caption?: ReactNode;
  line?: number;
  diagramId?: string;
  /** Reports the node/edge under the pointer (null when none). */
  onHover?: (t: HoverTarget | null) => void;
  /** Element to emphasise as the counterpart of a hover in the other diagram. */
  pairTarget?: HoverTarget | null;
  /** Paths through the selected element, emphasised without step badges. */
  related?: { edges: number[]; nodes: string[] } | null;
  /** Right-click: pin/unpin the element under the pointer (null for empty space). */
  onContext?: (t: HoverTarget | null) => void;
}

const MIN = 0.2;
const MAX = 8;
const MIN_H = 140;
const MAX_H = 560;
/** Minimum initial scale so labels stay legible; wider diagrams are panned instead. */
const READABLE = 0.6;

export function MermaidView({ code, graph, highlight, diff, toolbar, caption, line, diagramId, onHover, pairTarget, related, onContext }: MermaidViewProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const fitted = useRef(false);
  const sized = useRef(false);
  /** Set once the user pans/zooms; after that we stop auto-fitting on resize. */
  const touched = useRef(false);

  useEffect(() => {
    let alive = true;
    const id = `ddv-mmd-${++seq}`;
    mermaid
      .render(id, code)
      .then((r) => {
        if (!alive) return;
        setSvg(r.svg);
        setError('');
        fitted.current = false;
        sized.current = false;
        touched.current = false;
      })
      .catch((e: Error) => {
        document.getElementById(`d${id}`)?.remove();
        if (alive) setError(e?.message ?? String(e));
      });
    return () => {
      alive = false;
    };
  }, [code]);

  const svgEl = () => stage.current?.querySelector('svg') as SVGSVGElement | null;

  /** whole=true shows the entire diagram; otherwise keep text readable and allow panning. */
  const fit = useCallback((whole = false): boolean => {
    const el = svgEl();
    const vp = viewport.current;
    if (!el || !vp) return false;
    const vw = vp.clientWidth;
    // Not laid out yet (hidden / still mounting): retry from the ResizeObserver.
    if (vw < 80) return false;
    if (whole) touched.current = true;
    const vb = el.viewBox.baseVal;
    const w = vb?.width || el.getBoundingClientRect().width || 1;
    const h = vb?.height || el.getBoundingClientRect().height || 1;
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    el.style.maxWidth = 'none';
    const kw = Math.min(1.2, (vw - 24) / w);
    const kInit = whole ? kw : Math.max(kw, Math.min(READABLE, 1.2));
    let vh = vp.clientHeight;
    if (!sized.current) {
      // First fit: size the viewport to the diagram (user can resize afterwards).
      sized.current = true;
      vh = Math.round(Math.min(MAX_H, Math.max(MIN_H, h * kInit + 24)));
      vp.style.height = `${vh}px`;
    }
    const kFit = Math.min(1.5, Math.max(MIN, Math.min((vw - 24) / w, (vh - 24) / h)));
    const k = whole ? kFit : Math.max(kFit, Math.min(READABLE, (vh - 24) / h));
    // Wider than the viewport at this scale: start from the left edge.
    const x = w * k > vw - 24 ? 12 : (vw - w * k) / 2;
    setT({ k, x, y: (vh - h * k) / 2 });
    return true;
  }, []);

  useLayoutEffect(() => {
    if (!svg || fitted.current) return;
    fitted.current = fit();
  }, [svg, fit]);

  // Re-fit when the available width changes until the user starts interacting.
  useEffect(() => {
    const vp = viewport.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    let lastW = vp.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = vp.clientWidth;
      if (Math.abs(w - lastW) < 2 && fitted.current) return;
      lastW = w;
      if (touched.current) return;
      if (!fitted.current || sized.current) {
        sized.current = false;
        fitted.current = fit();
      }
    });
    ro.observe(vp);
    return () => ro.disconnect();
  }, [fit, error]);

  useEffect(() => {
    const el = svgEl();
    if (!el || !graph) return;
    clearMarks(el);
    if (diff) applyDiff(el, graph, diff);
    if (highlight) applyPathHighlight(el, graph, highlight);
    else if (related) applyPathHighlight(el, graph, related, false);
  }, [svg, graph, highlight, diff, related]);

  useEffect(() => {
    const el = svgEl();
    if (!el || !graph) return;
    clearPairHighlight(el);
    if (pairTarget) applyPairHighlight(el, graph, pairTarget);
  }, [svg, graph, highlight, diff, related, pairTarget]);

  const hoverKey = useRef<string | null>(null);
  const onMouseOver = (e: React.MouseEvent) => {
    if (!onHover || !graph || drag.current) return;
    const el = svgEl();
    if (!el) return;
    const tg = targetFromElement(el, graph, e.target as Element);
    const key = tg ? (tg.type === 'node' ? `n:${tg.id}` : `e:${tg.index}`) : null;
    if (key === hoverKey.current) return;
    hoverKey.current = key;
    onHover(tg);
  };
  const onContextMenu = (e: React.MouseEvent) => {
    if (!onContext) return;
    e.preventDefault();
    const el = svgEl();
    onContext(el && graph ? targetFromElement(el, graph, e.target as Element) : null);
  };
  const onMouseLeave = () => {
    if (hoverKey.current === null) return;
    hoverKey.current = null;
    onHover?.(null);
  };

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const vp = viewport.current;
    if (!vp) return;
    touched.current = true;
    const px = cx ?? vp.clientWidth / 2;
    const py = cy ?? vp.clientHeight / 2;
    setT((p) => {
      const k = Math.min(MAX, Math.max(MIN, p.k * factor));
      const r = k / p.k;
      return { k, x: px - (px - p.x) * r, y: py - (py - p.y) * r };
    });
  }, []);

  // Ctrl/Cmd + wheel zooms around the cursor; a plain wheel keeps scrolling the page.
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [zoomAt, error]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    touched.current = true;
    // Prevent text selection and native drag of SVG text while panning.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y };
    setDragging(true);
    document.body.classList.add('ddv-no-select');
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setT((p) => ({ ...p, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    document.body.classList.remove('ddv-no-select');
  };

  return (
    <figure className="mmd" data-line={line} data-diagram={diagramId}>
      <div className="mmd-toolbar">
        <div className="mmd-tools">
          <button type="button" title="拡大" aria-label="拡大" onClick={() => zoomAt(1.25)}>
            ＋
          </button>
          <button type="button" title="縮小" aria-label="縮小" onClick={() => zoomAt(0.8)}>
            －
          </button>
          <button type="button" title="全体を表示（ダブルクリックでも可）"           onClick={() => fit(true)}>
            フィット
          </button>
          <button type="button" title="等倍" onClick={() => zoomAt(1 / t.k)}>
            1:1
          </button>
          <span className="mmd-zoom" data-testid="zoom-level">
            {Math.round(t.k * 100)}%
          </span>
          <span className="mmd-hint">Ctrl+ホイールでズーム / ドラッグで移動</span>
        </div>
        {toolbar}
      </div>
      {error ? (
        <div className="mmd-error">
          <strong>Mermaid 構文エラー</strong>
          <pre>{error}</pre>
          <pre className="mmd-src">{code}</pre>
        </div>
      ) : (
        <div
          ref={viewport}
          className={`mmd-viewport${dragging ? ' is-dragging' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => fit(true)}
          onDragStart={(e) => e.preventDefault()}
          onMouseOver={onMouseOver}
          onContextMenu={onContextMenu}
          onMouseLeave={onMouseLeave}
          data-testid="mermaid-viewport"
        >
          <div ref={stage} className="mmd-stage" style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.k})` }} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      )}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
