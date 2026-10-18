import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../backend/index.ts';
import type { ScenarioDetail } from '../api.ts';
import { useApp, useLocalStorage } from '../state.tsx';
import { playableScenarios, useMockHub } from '../mockHub.tsx';
import { PlayerController, SPEEDS, STATE_LABEL, createFrameTransport, type DraftData, type FrameTransport, type PlayerSnapshot, type TuneMessage } from '../player.ts';
import type { TdScenario } from '../api.ts';
import type { PickedElement } from '@ddv/mock/tune-patch';
import { expandOnly, stepApplies } from '@ddv/mock/platform';
import { SnapshotPanel } from './SnapshotPanel.tsx';
import { TunePanel } from './TunePanel.tsx';
import { LiveTracePanel } from './LiveTracePanel.tsx';
import { EDITION, useMockSource, type MockSource } from '../mockSource.ts';
import { ISSUE_LABEL, MockDocumentBuilder, type BuildIssue } from '../mockDocument.ts';

const SIZES: Array<[string, number | null]> = [
  ['可変', null],
  ['PC 1280', 1280],
  ['タブレット 768', 768],
  ['スマホ 390', 390],
];

const SCENARIO_STATUS: Record<string, string> = { Unverified: '未確認', Passed: '再生OK', Failed: '再生NG', Retired: '欠番' };

const IDLE: PlayerSnapshot = { state: 'Idle', scenarioId: null, cursor: 0, total: 0, running: null, busy: false, speed: 1000, highlight: false, screen: null, failure: null, draft: false };
const noSubscribe = () => () => {};
const idleSnapshot = () => IDLE;

const show = (v: unknown) => (v === undefined ? '（なし）' : typeof v === 'string' ? v : JSON.stringify(v));

/** `::mock[path]{scenario=...}` — live mock preview with the scenario player (BD-MOCK-PLAYER). */
export function MockFrame({ target, attrs, source }: { target: string; attrs: Record<string, string>; source?: MockSource }) {
  const { config, route } = useApp();
  const hub = useMockHub();
  const ctxSource = useMockSource();
  const mockSource = source ?? ctxSource;
  const pages = EDITION === 'pages';
  /** Pages: the built srcdoc of the current ⟳ (DD-MOCKSB). */
  const [built, setBuilt] = useState<{ srcdoc: string; issues: BuildIssue[] } | null>(null);
  const htmlPath = config ? `${config.mocksRoot.replace(/\/$/, '')}/${target.replace(/^\//, '')}` : '';
  const [width, setWidth] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [ctl, setCtl] = useState<PlayerController | null>(null);
  const [mockError, setMockError] = useState('');
  const [speed, setSpeed] = useLocalStorage('ddv.playerSpeed', 1000);
  const [opHighlight, setOpHighlight] = useLocalStorage('ddv.playerHighlight', false);
  const [request, setRequest] = useState<{ id: string; play: boolean; seq: number; draft?: { scenario: TdScenario; data: DraftData; seq: number } }>({ id: '', play: false, seq: 0 });
  /** Seq of the preview (編集中の再生) being played here, 0 = none. */
  const activePreview = useRef(0);
  const endPreview = useRef(hub?.endPreview);
  endPreview.current = hub?.endPreview;
  const [detail, setDetail] = useState<ScenarioDetail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadedSeq, setLoadedSeq] = useState(-1);
  const transport = useRef<FrameTransport | null>(null);
  const [tuning, setTuning] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [picked, setPicked] = useState<{ el: PickedElement; seq: number } | null>(null);
  const sendTune = useCallback((m: TuneMessage) => transport.current?.send(m), []);

  const scenarios = useMemo(() => playableScenarios(hub?.scenarios ?? [], target), [hub?.scenarios, target]);
  const hasPlayer = scenarios.length > 0;
  const registerMock = hub?.registerMock;
  const refreshScenarios = hub?.refreshScenarios;
  const setHighlight = hub?.setHighlight;

  useEffect(() => registerMock?.(target), [registerMock, target]);

  useEffect(() => {
    const t = createFrameTransport(() => frame.current, {
      onMessage: (m) => {
        if (m.type === 'ddv:ready' || m.type === 'ddv:screen') c.setScreen(m.screen ?? null);
        if (m.type === 'ddv:ready') setMockError('');
        if (m.type === 'ddv:error') setMockError(m.message);
        if (m.type === 'ddv:picked') {
          const { type: _type, ...el } = m;
          setPicked((p) => ({ el, seq: (p?.seq ?? 0) + 1 }));
        }
      },
      edition: EDITION,
      onSession: (s) => {
        if (s.state === 'Failed') setMockError(s.failure);
      },
    });
    transport.current = t;
    let alive = true;
    if (pages) {
      setBuilt(null);
      const build = async () => {
        if (!mockSource) throw new Error('モックの読み込み元がありません');
        const { MOCK_RUNTIME_JS } = await import('../mockRuntime.ts');
        return new MockDocumentBuilder(mockSource.reader, MOCK_RUNTIME_JS, window.location.origin).build(htmlPath);
      };
      build().then(
        (b) => {
          if (!alive) return;
          setBuilt({ srcdoc: b.srcdoc, issues: b.issues });
          t.built(b.files);
        },
        (e: Error) => {
          if (alive) t.buildFailed(e?.message ?? String(e));
        },
      );
    }
    const c = new PlayerController(t, {
      onFinish: (r) => {
        void api
          .played({ id: r.id, ok: r.ok, ...(r.ok ? {} : { failures: r.failures }) })
          .catch(() => {})
          .finally(() => refreshScenarios?.());
      },
      // The data being edited: not reported as played (DD-TDEDIT 編集中の再生)
      onDraftFinish: (r) => {
        const seq = activePreview.current;
        activePreview.current = 0;
        if (seq) endPreview.current?.({ seq, ok: r.ok, failure: c.getSnapshot().failure });
      },
    });
    setCtl(c);
    return () => {
      alive = false;
      c.dispose();
      t.dispose();
      if (transport.current === t) transport.current = null;
    };
    // htmlPath/mockSource only matter for the Pages edition; ⟳ (nonce) rebuilds
  }, [nonce, refreshScenarios, pages ? htmlPath : '', pages ? mockSource : null]);

  const snap = useSyncExternalStore(ctl?.subscribe ?? noSubscribe, ctl?.getSnapshot ?? idleSnapshot);

  useEffect(() => ctl?.setSpeed(speed), [ctl, speed]);
  useEffect(() => ctl?.setHighlight(opHighlight), [ctl, opHighlight]);

  // Default scenario: the `scenario` attribute when it names one, else the first
  useEffect(() => {
    if (!scenarios.length || scenarios.some((s) => s.id === request.id)) return;
    const def = scenarios.find((s) => s.id === attrs.scenario) ?? scenarios[0];
    setRequest((r) => ({ id: def.id, play: false, seq: r.seq + 1 }));
  }, [scenarios, request.id, attrs.scenario]);

  // ▶ モック from the matrix
  const playRequest = hub?.playRequest;
  const handled = useRef(0);
  const autoPlayed = useRef(0);
  useEffect(() => {
    if (!playRequest || playRequest.seq === handled.current) return;
    if (!scenarios.some((s) => s.id === playRequest.id)) return;
    handled.current = playRequest.seq;
    setRequest((r) => ({ id: playRequest.id, play: true, seq: r.seq + 1 }));
    root.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [playRequest, scenarios]);

  // ▶ 再生（編集中のデータ） from the test data editor
  const preview = hub?.preview;
  const previewHandled = useRef(0);
  useEffect(() => {
    if (!preview || preview.seq === previewHandled.current) return;
    if (!scenarios.some((s) => s.id === preview.id)) return;
    previewHandled.current = preview.seq;
    setTuning(false);
    setRequest((r) => ({ id: preview.id, play: false, seq: r.seq + 1, draft: { scenario: preview.scenario, data: preview.data, seq: preview.seq } }));
    root.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [preview, scenarios]);

  // 再生終了 when the draft playback is stopped (リセット) or replaced (another scenario)
  useEffect(() => {
    const seq = activePreview.current;
    if (!seq || (snap.draft && !(snap.state === 'Idle' && !snap.busy))) return;
    activePreview.current = 0;
    hub?.endPreview({ seq, ok: false, failure: null });
  });

  useEffect(() => {
    if (!ctl || !request.id) return;
    let alive = true;
    setLoadError('');
    api
      .scenario(request.id)
      .then((d) => {
        if (!alive) return;
        const draft = request.draft;
        setDetail(draft ? { ...d, scenario: draft.scenario } : d);
        setLoadedSeq(request.seq);
        if (draft) {
          activePreview.current = draft.seq;
          ctl.playDraft({ id: d.id, fixtures: draft.scenario.fixtures ?? [], start: draft.scenario.start, steps: draft.scenario.steps ?? [] }, draft.data);
          return;
        }
        ctl.load(d.scenario ? { id: d.id, fixtures: d.scenario.fixtures ?? [], start: d.scenario.start, steps: d.scenario.steps ?? [] } : null);
        if (d.scenario && request.play && autoPlayed.current !== request.seq) {
          autoPlayed.current = request.seq;
          ctl.play();
        }
      })
      .catch((e: Error) => {
        if (!alive) return;
        setDetail(null);
        ctl.load(null);
        setLoadError(e.message);
        if (request.draft) hub?.endPreview({ seq: request.draft.seq, ok: false, failure: null });
      });
    return () => {
      alive = false;
    };
  }, [ctl, request]);

  // Emphasise the transitions played so far on the screen diagram (only in the document that owns it)
  const diagram = detail && detail.doc === route.path ? detail.diagram : null;
  useEffect(() => {
    if (!setHighlight || !diagram || !detail) return;
    if (snap.state === 'Idle' || snap.scenarioId !== detail.id) {
      setHighlight(diagram, null);
      return;
    }
    const tr = detail.transitions ?? [];
    const failedHere = snap.failure?.index === snap.cursor ? 1 : 0;
    const n = Math.min(tr.length, snap.cursor + (snap.running !== null ? 1 : failedHere));
    const used = tr.slice(0, n);
    const nodes = tr.length ? [tr[0].from, ...used.map((t) => t.to)] : [];
    setHighlight(diagram, {
      edges: used.map((t) => t.edge),
      nodes: [...new Set(nodes)],
      scenarioId: detail.id,
      caption: `ステップ ${snap.cursor} / ${snap.total}（${STATE_LABEL[snap.state]}）`,
    });
  }, [setHighlight, diagram, detail, snap]);
  useEffect(() => (setHighlight && diagram ? () => setHighlight(diagram, null) : undefined), [setHighlight, diagram]);

  const select = useCallback((id: string) => setRequest((r) => ({ id, play: false, seq: r.seq + 1 })), []);

  // Local: the mock's URL (Pages builds srcdoc from the target's reader instead).
  const [src, setSrc] = useState('');
  useEffect(() => {
    // `EDITION` (not `pages`) so that the Pages bundle drops the local `/raw/` URL
    if (EDITION === 'pages' || !htmlPath) return;
    let alive = true;
    void api.rawUrl(`/raw/${htmlPath}`).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [pages, htmlPath]);

  if (!config) return null;
  const tabUrl = pages ? mockSource?.blobUrl?.(htmlPath) : src || undefined;
  const steps = detail?.scenario?.steps ?? [];
  const { state, busy, cursor, total, failure } = snap;
  // Disabled until the latest selection (even of the same scenario) has been loaded into the controller
  const loaded = !!detail && snap.scenarioId === detail.id && loadedSeq === request.seq;
  const can = {
    play: !tuning && loaded && !busy && (state === 'Idle' || state === 'Paused'),
    pause: state === 'Playing',
    step: !tuning && loaded && !busy && (state === 'Idle' || state === 'Paused'),
    rewind: !tuning && loaded && (state === 'Paused' || state === 'Done' || state === 'Failed'),
    tune: !tuning && !busy && state !== 'Playing',
  };
  const startTune = () => {
    sendTune({ type: 'ddv:tune', on: true });
    setTuning(true);
  };
  const rewindTarget = state === 'Failed' ? cursor : Math.max(0, cursor - 1);
  const stepStatus = (i: number) =>
    snap.running === i ? 'running' : failure?.index === i ? 'failed' : i < cursor && state !== 'Idle' ? 'done' : i === cursor && state !== 'Idle' ? 'next' : 'pending';

  return (
    <div className="mock" data-testid="mock" ref={root}>
      <div className="mock-toolbar">
        <strong>モック</strong>
        <code>{target}</code>
        {!hasPlayer && attrs.scenario && <span className="chip">シナリオ: {attrs.scenario}</span>}
        <span className="spacer" />
        {SIZES.map(([label, w]) => (
          <button key={label} type="button" className={width === w ? 'is-active' : ''} onClick={() => setWidth(w)}>
            {label}
          </button>
        ))}
        <button type="button" data-testid="tune-start" disabled={!can.tune} onClick={startTune} title={state === 'Playing' ? 'シナリオの再生中は調整できません' : '要素を選んで文言・属性を調整する'}>
          調整
        </button>
        <button
          type="button"
          onClick={() => {
            setTuning(false);
            setNonce((n) => n + 1);
          }}
          title="再読込"
        >
          ⟳
        </button>
        {tabUrl && (
          <a href={tabUrl} target="_blank" rel="noreferrer">
            別タブ ↗
          </a>
        )}
      </div>
      {hasPlayer && (
        <div className="player" data-testid="player">
          <select data-testid="player-scenario" value={request.id} onChange={(e) => select(e.target.value)} title="シナリオ" disabled={state === 'Playing' || tuning}>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} [{SCENARIO_STATUS[s.status] ?? s.status}] {s.title}
              </option>
            ))}
          </select>
          <button type="button" className="primary" data-testid="player-play" disabled={!can.play} onClick={() => ctl?.play()} title="再生">
            ▶ 再生
          </button>
          <button type="button" data-testid="player-pause" disabled={!can.pause} onClick={() => ctl?.pause()} title="一時停止">
            ⏸ 一時停止
          </button>
          <button type="button" data-testid="player-step" disabled={!can.step} onClick={() => ctl?.step()} title="1ステップ進める">
            ⏭ 1ステップ
          </button>
          <button type="button" data-testid="player-rewind" disabled={!can.rewind} onClick={() => ctl?.rewind(rewindTarget)} title="1ステップ戻す（DBリセット→先頭から再実行）">
            ⏮ 巻き戻し
          </button>
          <button type="button" data-testid="player-reset" disabled={!can.rewind} onClick={() => ctl?.reset()} title="停止に戻す">
            リセット
          </button>
          <label className="player-speed">
            速度
            <select data-testid="player-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => (
                <option key={s.ms} value={s.ms}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="player-highlight" title="入力・クリックする要素を枠で示してから操作します">
            <input type="checkbox" data-testid="player-highlight" checked={opHighlight} onChange={(e) => setOpHighlight(e.target.checked)} />
            操作をハイライト
          </label>
          <button type="button" data-testid="trace-live-toggle" className={traceOpen ? 'is-active' : ''} aria-pressed={traceOpen} onClick={() => setTraceOpen((v) => !v)} title="再生中のステップの記録（API・DB の変化など）を表示">
            トレース
          </button>
          {hub && request.id && (
            <button type="button" data-testid="td-open" onClick={() => hub.openTestData(request.id)} title="このシナリオのテストデータ（入力値・期待値・fixtures）を表示・編集">
              テストデータ
            </button>
          )}
          {snap.draft && (
            <span className="chip warn" data-testid="player-draft">
              編集中のデータ
            </span>
          )}
          <span className="player-progress" data-testid="player-progress">
            {cursor} / {total}
          </span>
          <span className={`player-status st-${state}`} data-testid="player-status" data-state={state}>
            {STATE_LABEL[state]}
            {busy && state !== 'Playing' ? '…' : ''}
          </span>
          {snap.screen && (
            <span className="muted" title="モックの表示中の画面">
              画面: <code>{snap.screen}</code>
            </span>
          )}
        </div>
      )}
      {loadError && <div className="notice warn">⚠ シナリオを読み込めません: {loadError}</div>}
      {mockError && <div className="notice warn">⚠ モック: {mockError}</div>}
      {pages && built && built.issues.length > 0 && (
        <details className="notice warn" data-testid="mock-build-issues">
          <summary>⚠ Pages 版では読み込めない参照があります（{built.issues.length} 件）</summary>
          <ul>
            {built.issues.map((i, n) => (
              <li key={n}>
                <code>{i.ref}</code>（<code>{i.from}</code>）: {ISSUE_LABEL[i.kind]}
              </li>
            ))}
          </ul>
        </details>
      )}
      {tuning && <TunePanel mock={target} picked={picked} send={sendTune} onEnd={() => setTuning(false)} />}
      {detail?.issues?.map((m, i) => (
        <div key={i} className="notice warn">
          ⚠ {m}
        </div>
      ))}
      {failure && (
        <div className="player-failure" data-testid="player-failure">
          <strong>
            {failure.index === null ? 'モックを初期化できません' : `ステップ ${failure.index + 1}「${failure.event ?? ''}」で失敗`}
          </strong>
          {failure.message && <div>{failure.message}</div>}
          {failure.index !== null && (
            <div className="muted">
              期待した画面: <code>{failure.expectedScreen}</code> / 実際の画面: <code>{failure.screen ?? '（不明）'}</code>
            </div>
          )}
          {failure.failures.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>項目</th>
                  <th>期待値</th>
                  <th>実際</th>
                </tr>
              </thead>
              <tbody>
                {failure.failures.map((f, i) => (
                  <tr key={i}>
                    <td>
                      <code>{f.key}</code>
                    </td>
                    <td>{show(f.expected)}</td>
                    <td className="actual">{show(f.actual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className={`mock-body${hasPlayer ? ' with-steps' : ''}`}>
        <div className="mock-stage">
          {pages ? (
            <iframe
              key={nonce}
              ref={frame}
              title={target}
              srcDoc={built?.srcdoc ?? ''}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              style={{ width: width ? `${width}px` : '100%' }}
            />
          ) : (
            src && <iframe key={nonce} ref={frame} title={target} src={src} style={{ width: width ? `${width}px` : '100%' }} />
          )}
        </div>
        {hasPlayer && (
          <ol className="player-steps" data-testid="player-steps" aria-label="ステップ（クリックでそこまで巻き戻し）">
            {steps.map((s, i) => (
              <li key={i} data-testid="player-step-item" data-index={i} data-status={stepStatus(i)} className={`ps-${stepStatus(i)}${stepApplies(s, 'web') ? '' : ' ps-skipped'}`}>
                <button type="button" disabled={!can.rewind} onClick={() => ctl?.rewind(i)} title={can.rewind ? 'このステップの手前まで巻き戻す' : '一時停止・完了・失敗のときに巻き戻せます'}>
                  <span className="ps-no">{i + 1}</span>
                  {s.event !== undefined ? <span className="ps-event">{s.event}</span> : <span className="ps-event ps-aux">補助{s.click ?? s.do ? `・${s.click ?? s.do}` : ''}</span>}
                  {s.expect?.screen !== undefined && <span className="ps-screen">→ {s.expect.screen}</span>}
                  {!stepApplies(s, 'web') && <span className="ps-only">（{expandOnly(s.only).join('・')} だけ）</span>}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      {hasPlayer && traceOpen && ctl && <LiveTracePanel live={ctl.liveTrace} />}
      {hasPlayer && <SnapshotPanel scenarioId={request.id} />}
    </div>
  );
}
