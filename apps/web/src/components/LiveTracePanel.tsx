import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LiveTrace } from '../player.ts';
import { TraceStepDetail, TraceTimeline } from './TraceStepDetail.tsx';

export const LIVE_UNSUPPORTED = 'この runtime は記録に対応していません（ddv mock init で更新してください）';

/** The player's live trace: same timeline and details as the trace view, without screenshots (DD-TRVIEW ライブ表示). */
export function LiveTracePanel({ live }: { live: LiveTrace }) {
  const snap = useSyncExternalStore(live.subscribe, live.getSnapshot);
  const [selected, setSelected] = useState<number | null>(null);
  const lastCount = useRef(0);

  // Follow the newest record unless the user picked another one meanwhile
  useEffect(() => {
    const last = snap.steps.at(-1)?.index ?? null;
    if (!snap.steps.length) setSelected(null);
    else if (snap.steps.length !== lastCount.current || selected === null || !snap.steps.some((s) => s.index === selected)) setSelected(last);
    lastCount.current = snap.steps.length;
  }, [snap.steps]);

  const step = snap.steps.find((s) => s.index === selected) ?? null;
  return (
    <div className="trace-live" data-testid="trace-live">
      <div className="trace-live-head">
        <strong>トレース</strong>
        {snap.draft && (
          <span className="chip warn" data-testid="trace-live-draft">
            編集中のデータで再生中
          </span>
        )}
      </div>
      {!snap.supported && <div className="notice warn">{LIVE_UNSUPPORTED}</div>}
      {snap.steps.length ? (
        <div className="trace-split">
          <TraceTimeline steps={snap.steps} selected={selected} onSelect={setSelected} />
          <div className="trace-main">{step && <TraceStepDetail step={step} plan={snap.plans[step.index]} />}</div>
        </div>
      ) : (
        <p className="muted">再生するとステップの記録がここに出ます</p>
      )}
    </div>
  );
}
