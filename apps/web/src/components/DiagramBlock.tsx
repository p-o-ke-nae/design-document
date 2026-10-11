import { useEffect, useMemo, useState } from 'react';
import { diffGraphs, pathsThrough } from '@ddv/graph';
import type { DiagramBlock as Diagram, DocResponse, GraphDiff, Matrix, MatrixCase } from '../api.ts';
import type { HoverTarget } from '../highlight.ts';
import { useApp } from '../state.tsx';
import { useMockHub } from '../mockHub.tsx';
import { MermaidView } from './MermaidView.tsx';
import { MatrixPanel } from './MatrixPanel.tsx';

type Side = 'before' | 'after';
type Targets = { before: HoverTarget | null; after: HoverTarget | null };

const DIFF_LABEL: Record<string, string> = { added: '追加', removed: '削除', changed: '変更' };

export function DiagramBlock({ doc, diagram }: { doc: DocResponse; diagram: Diagram }) {
  const { showMatrix } = useApp();
  const graph = doc.graphs[diagram.id];
  const matrix: Matrix | undefined = doc.matrices.find((m) => m.diagram === diagram.id);
  const diff = doc.diffs[diagram.id];
  const [selected, setSelected] = useState<string | null>(null);
  const [localMatrix, setLocalMatrix] = useState<boolean | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const matrixVisible = localMatrix ?? showMatrix;
  const sel: MatrixCase | undefined = matrix?.cases.find((c) => c.id === selected);
  const play = useMockHub()?.highlights[diagram.id];
  const highlight = useMemo(() => (sel ? { edges: sel.edges, nodes: sel.nodes } : play ? { edges: play.edges, nodes: play.nodes } : null), [sel, play]);

  const before = diff ? doc.diagrams.find((d) => d.id === diff.compare) : undefined;
  const beforeGraph = before ? doc.graphs[before.id] : undefined;

  const [pairHover, setPairHover] = useState(true);
  const [hover, setHover] = useState<{ side: Side; target: HoverTarget } | null>(null);
  const [pinned, setPinned] = useState<{ side: Side; target: HoverTarget } | null>(null);
  const [rowTargets, setRowTargets] = useState<Targets | null>(null);

  // Computed here (not taken from the server) so pairing works regardless of server version.
  const pairs = useMemo(() => (beforeGraph && graph ? diffGraphs(beforeGraph, graph).pairs : null), [beforeGraph, graph]);

  const sel2 = pinned ?? hover;
  const pairTargets: Targets = useMemo(() => {
    if (!pairHover) return { before: null, after: null };
    if (!pinned && rowTargets) return rowTargets;
    if (!sel2 || !pairs) return { before: null, after: null };
    const t = sel2.target;
    const from = sel2.side;
    const to: Side = from === 'before' ? 'after' : 'before';
    let other: HoverTarget | null = null;
    if (t.type === 'node') {
      if (pairs.nodes.includes(t.id)) other = t;
    } else {
      const p = pairs.edges.find((x) => x[from] === t.index);
      if (p) other = { type: 'edge', index: p[to] };
    }
    return { [from]: t, [to]: other } as Targets;
  }, [pairHover, rowTargets, pinned, sel2, pairs]);

  const relatedFor = (g: typeof graph | undefined, t: HoverTarget | null) => (g && t ? pathsThrough(g, t) : null);
  const relatedBefore = useMemo(() => relatedFor(beforeGraph, pairTargets.before), [beforeGraph, pairTargets.before]);
  const relatedAfter = useMemo(() => relatedFor(graph, pairTargets.after), [graph, pairTargets.after]);

  const onContext = (side: Side) => (t: HoverTarget | null) => {
    const same = pinned && t && pinned.side === side && JSON.stringify(pinned.target) === JSON.stringify(t);
    setPinned(t && !same ? { side, target: t } : null);
    // after unpinning, resume hover on whatever is under the pointer
    if (!t || same) setHover(t ? { side, target: t } : null);
  };

  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPinned(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  useEffect(() => {
    if (!pairHover || !showDiff) {
      setPinned(null);
      setHover(null);
    }
  }, [pairHover, showDiff]);

  const hoverProps = (side: Side) =>
    pairHover && showDiff && pairs
      ? { onHover: (t: HoverTarget | null) => !pinned && setHover(t ? { side, target: t } : null), onContext: onContext(side) }
      : {};

  const rowHover = (it: GraphDiff['items'][number] | null) => {
    if (!it) return setRowTargets(null);
    const hasBefore = it.status !== 'added';
    const hasAfter = it.status !== 'removed';
    if (it.type === 'node') {
      setRowTargets({ before: hasBefore ? { type: 'node', id: it.key } : null, after: hasAfter ? { type: 'node', id: it.key } : null });
      return;
    }
    const [f, t] = it.key.split('->');
    const find = (g: typeof graph | undefined, label: string | undefined, has: boolean): HoverTarget | null => {
      const e = has ? g?.edges.find((x) => x.from === f && x.to === t && (x.label ?? '') === (label ?? '')) : undefined;
      return e ? { type: 'edge', index: e.index } : null;
    };
    setRowTargets({ before: find(beforeGraph, it.before, hasBefore), after: find(graph, it.after, hasAfter) });
  };

  const toolbar = (
    <div className="mmd-tools">
      <span className="chip" title="図ID">
        #{diagram.id}
      </span>
      {matrix && (
        <label className="toggle">
          <input type="checkbox" checked={matrixVisible} onChange={(e) => setLocalMatrix(e.target.checked)} data-testid="matrix-toggle" />
          マトリクス
        </label>
      )}
      {diff && (
        <>
          <label className="toggle">
            <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} />
            As-Is と比較
          </label>
          {showDiff && (
            <label className="toggle" title="片方の図形にホバーすると、もう片方の対応する図形と通る経路を強調します。右クリックで固定/解除">
              <input type="checkbox" checked={pairHover} onChange={(e) => setPairHover(e.target.checked)} data-testid="pair-hover-toggle" />
              対応ホバー（右クリックで固定）
            </label>
          )}
        </>
      )}
    </div>
  );

  const main = (
    <MermaidView
      code={diagram.code}
      graph={graph}
      highlight={highlight}
      diff={diff && showDiff ? diff.after : null}
      toolbar={toolbar}
      line={diagram.line}
      diagramId={diagram.id}
      {...hoverProps('after')}
      pairTarget={pairTargets.after}
      related={relatedAfter}
      caption={
        sel ? (
          <span className="hl-caption">選択中: <strong>{sel.id}</strong> {sel.title}</span>
        ) : play ? (
          <span className="hl-caption" data-testid="play-caption">
            ▶ モック再生: <strong>{play.scenarioId}</strong> {play.caption}
          </span>
        ) : pinned ? (
          <span className="hl-caption" data-testid="pin-caption">固定中（右クリック / Esc で解除）</span>
        ) : undefined
      }
    />
  );

  return (
    <div className="diagram-block" id={`diagram-${diagram.id}`}>
      {diff && showDiff && before ? (
        <>
          <div className="compare">
            <div>
              <div className="compare-label">As-Is: #{before.id}</div>
              <MermaidView code={before.code} graph={doc.graphs[before.id]} diff={diff.before} diagramId={`${before.id}-compare`} {...hoverProps('before')} pairTarget={pairTargets.before} related={relatedBefore} />
            </div>
            <div>
              <div className="compare-label">To-Be: #{diagram.id}</div>
              {main}
            </div>
          </div>
          <div className="legend">
            <span className="lg added">追加</span>
            <span className="lg removed">削除</span>
            <span className="lg changed">変更</span>
          </div>
          <details className="gap" open>
            <summary>ギャップ（{diff.items.length} 件）</summary>
            <div className="table-wrap">
              <table data-testid="gap-table">
                <thead>
                  <tr>
                    <th>種別</th>
                    <th>差分</th>
                    <th>要素</th>
                    <th>As-Is</th>
                    <th>To-Be</th>
                    <th>要件</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.items.map((it, i) => (
                    <tr key={i} className={`diff-${it.status}`} onMouseEnter={() => rowHover(it)} onMouseLeave={() => rowHover(null)}>
                      <td>{it.type === 'node' ? 'ノード' : '遷移'}</td>
                      <td>
                        <span className={`badge diff-${it.status}`}>{DIFF_LABEL[it.status]}</span>
                      </td>
                      <td>
                        <code>{it.key}</code>
                      </td>
                      <td>{it.before ?? ''}</td>
                      <td>{it.after ?? ''}</td>
                      <td>{it.reqs.length ? it.reqs.join(', ') : <span className="warn">未対応</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        main
      )}
      {matrix && matrixVisible && <MatrixPanel matrix={matrix} selected={selected} onSelect={setSelected} />}
    </div>
  );
}
