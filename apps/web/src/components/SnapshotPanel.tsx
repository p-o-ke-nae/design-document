import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SnapshotInfo, type SnapshotStatus } from '../api.ts';

const STATUS_LABEL: Record<SnapshotStatus, string> = { None: '未撮影', NoBase: '基準なし', Match: '一致', Diff: '差分あり' };

function bust(url: string, stamp: number) {
  return `${url}${url.includes('?') ? '&' : '?'}t=${stamp}`;
}

/** Snapshot shots of the scenario steps: baseline / current / diff and approval (BD-MOCK-SNAP). */
export function SnapshotPanel({ scenarioId }: { scenarioId: string }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<SnapshotInfo | null>(null);
  const [stamp, setStamp] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const es = useRef<EventSource | null>(null);

  const refresh = useCallback(() => {
    if (!scenarioId) return;
    api
      .snapshots(scenarioId)
      .then((r) => {
        setInfo(r);
        setStamp(Date.now());
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, [scenarioId]);

  useEffect(() => {
    setInfo(null);
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => () => es.current?.close(), []);

  const run = async (ids?: string[]) => {
    setError('');
    let runId: string;
    try {
      runId = (await api.runSnapshots(ids ? { ids } : {})).runId;
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setRunning(true);
    setLog([]);
    es.current?.close();
    const src = new EventSource(`/api/runs/${runId}/events`);
    es.current = src;
    const done = (e?: Event) => {
      src.close();
      setRunning(false);
      refresh();
      let status = '';
      try {
        status = (JSON.parse((e as MessageEvent | undefined)?.data ?? '{}') as { status?: string }).status ?? '';
      } catch {
        /* ignore */
      }
      if (status && status !== 'passed') setError(`撮影が完了しませんでした（${status}）`);
    };
    src.addEventListener('step', refresh);
    src.addEventListener('scenario', refresh);
    src.addEventListener('message', refresh);
    src.addEventListener('log', (e) => setLog((l) => [...l.slice(-19), (e as MessageEvent).data]));
    src.addEventListener('end', done);
    src.onerror = () => done();
  };

  const approve = async (steps?: number[]) => {
    try {
      await api.approveSnapshots({ id: scenarioId, ...(steps ? { steps } : {}) });
    } catch (e) {
      setError((e as Error).message);
    }
    refresh();
  };

  const pending = info?.steps.filter((s) => s.status === 'NoBase' || s.status === 'Diff') ?? [];

  return (
    <details className="snapshot" data-testid="snapshot-panel" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        スナップショット
        {pending.length > 0 && <span className="chip warn">要承認 {pending.length}</span>}
      </summary>
      <div className="snapshot-tools">
        <button type="button" className="primary" data-testid="snapshot-run" disabled={running || !scenarioId} onClick={() => void run([scenarioId])}>
          📷 このシナリオを撮影
        </button>
        <button type="button" data-testid="snapshot-run-all" disabled={running} onClick={() => void run()}>
          全シナリオを撮影
        </button>
        <button type="button" data-testid="snapshot-approve-all" disabled={running || !pending.length} onClick={() => void approve()}>
          すべて承認
        </button>
        {running && <span className="muted">撮影中…</span>}
        {info?.browser && <span className="muted">ブラウザ: {info.browser}</span>}
      </div>
      {error && <div className="notice warn">⚠ {error}</div>}
      {error && log.length > 0 && <pre className="snapshot-log">{log.join('\n')}</pre>}
      {info && !info.steps.length && <div className="muted">まだ撮影していません</div>}
      {info?.steps.map((s) => (
        <section key={s.step} className={`snapshot-step snap-${s.status}`} data-testid="snapshot-step" data-step={s.step} data-status={s.status}>
          <header>
            <strong>ステップ {s.step}</strong>
            <span className={`snap-status snap-${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
            {typeof s.diffRatio === 'number' && <span className="muted">差分 {(s.diffRatio * 100).toFixed(2)}%</span>}
            <span className="spacer" />
            {(s.status === 'NoBase' || s.status === 'Diff') && (
              <button type="button" data-testid="snapshot-approve" disabled={running} onClick={() => void approve([s.step])}>
                承認
              </button>
            )}
          </header>
          {s.warnings.map((w, i) => (
            <div key={i} className="notice warn">
              ⚠ {w}
            </div>
          ))}
          <div className="snapshot-images">
            {(['baseline', 'current', 'diff'] as const).map((k) => (
              <figure key={k}>
                <figcaption>{k === 'baseline' ? '基準' : k === 'current' ? '今回' : '差分'}</figcaption>
                {s.images[k] ? (
                  <a href={s.images[k]} target="_blank" rel="noreferrer">
                    <img src={bust(s.images[k]!, stamp)} alt={`ステップ ${s.step} ${k}`} loading="lazy" />
                  </a>
                ) : (
                  <div className="muted snapshot-none">なし</div>
                )}
              </figure>
            ))}
          </div>
        </section>
      ))}
    </details>
  );
}
