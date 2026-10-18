import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TraceResponse } from '../api.ts';
import { parseResultKey } from '@ddv/services';
import { api, workspace } from '../backend/index.ts';
import { baseName } from '../evidence-view.ts';
import { ApiError } from '../backend/types.ts';
import {
  actionsApi,
  loadActionsStatus,
  onActionsEvent,
  onActionsStatus,
  splitIds,
  trackerOf,
  type ActionsRunDetail,
  type ActionsRunList,
  type ActionsRunRow,
  type ActionsStatus,
  type TrackerUpdate,
} from '../actionsApi.ts';
import { GateReason, useGate } from '../gate.tsx';
import { actionsHref, useApp, viewHref } from '../state.tsx';
import { StatusBadge } from './StatusBadge.tsx';
import { TraceView } from './TraceView.tsx';
import type { EvidenceLoader } from './EvidencePanel.tsx';

/** Screen texts (actions-run.md「画面」). */
export const ACTIONS_TEXT = {
  queuedConfirm: (request: string) => `待機中の実行 ${request} はキャンセルされます（GitHub は待機を 1 件しか持てません）。起動しますか`,
  waitPrevious: '前の実行が終わるまで待ちます',
  uncommitted: (sha: string) => `未コミットの変更は Actions では実行されません（${sha} を実行します）`,
  noChecks: 'この PR の CI の結果はありません',
  cancelled: '待機中に新しい実行が起動されたためキャンセルされました',
  dispatchFailed: '起動に失敗しました',
  pollError: '状態を取得できません（再試行中）',
  missing: '結果ブランチにこの実行の結果がありません（ワークフローが途中で失敗したか、削除されました）',
  broken: 'run.json を読めません',
  trimmedImages: '古い実行のため画像は削除されました',
  noChange: '基準画像に変更はありませんでした',
  approveStatus: (ref: string) => `承認のワークフローが PR のブランチ（${ref}）へコミットします`,
  placed: (p: string) => `${p} を配置しました。コミットして既定ブランチにマージしてください。既存の PR のブランチには既定ブランチを取り込んでください`,
  unchanged: '既に同じワークフローがあります',
  approveIds: '差分のあるシナリオを選んでください',
  notPr: 'PR のワークスペースで承認してください',
  trimmed: '古い実行のため画像が削除されています。もう一度実行してください',
} as const;

const ROW_STATE: Record<ActionsRunRow['state'], string> = {
  queued: '待機中',
  in_progress: '実行中',
  passed: '成功',
  failed: '失敗',
  error: 'エラー',
  cancelled: 'キャンセル',
  'no-result': '結果なし',
};

// Messages carried over a hash change (the screens are separate components).
let listFlash: { text: string; url?: string } | null = null;
const approveFlash = new Map<string, { commit?: string | null; error?: string }>();
/** Approval request → the result id it approves (to return to its 実行の結果). */
const approveOrigin = new Map<string, string>();
const waitNotes = new Set<string>();
const dispatchedAt = new Map<string, number>();
/** Ids handed over by a matrix row's 「Actionsで実行」 (dispatched as soon as the list is ready). */
let pendingDispatch: string[] | null = null;

/** Opens the Actions list with `ids` and starts a run (matrix-run-actions). */
export function dispatchFromMatrix(ids: string[]): void {
  pendingDispatch = ids;
  location.hash = actionsHref();
}

const pad = (n: number) => String(n).padStart(2, '0');
function fmtAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const sha7 = (s?: string) => (s ?? '').slice(0, 7);

export function useActionsStatus(): ActionsStatus | null {
  const { version } = useApp();
  const [s, setS] = useState<ActionsStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void loadActionsStatus().then((x) => alive && setS(x));
    const off = onActionsStatus((x) => alive && setS(x));
    return () => {
      alive = false;
      off();
    };
  }, [version]);
  return s;
}

/** 「手元」/「Actions」 switch of the tests tab (only when `GET /api/actions` is not `hidden`). */
export function TestsTabs({ actions }: { actions: boolean }) {
  const s = useActionsStatus();
  if (!s || s.state === 'hidden') return null;
  return (
    <nav className="tests-tabs" data-testid="tests-tabs">
      <a href={viewHref('tests')} className={actions ? '' : 'is-active'} data-testid="tests-local">
        手元
      </a>
      <a href={actionsHref()} className={actions ? 'is-active' : ''} data-testid="actions-tab">
        Actions
      </a>
    </nav>
  );
}

/** `#/tests/actions/...` (actions-run.md「画面」: List / Setup / Dispatching・Running・Approving / Detail). */
export function ActionsPanel({ path }: { path: string }) {
  const status = useActionsStatus();
  if (!status) return <div className="empty muted">読み込み中…</div>;
  if (status.state === 'hidden')
    return (
      <div className="tests-page actions-page">
        <p className="muted">このワークスペースでは Actions を使えません（{status.reason || 'GitHub のリモートがありません'}）</p>
      </div>
    );
  const tm = /^runs\/([^/]+)\/trace\/([^/]+)$/.exec(path);
  if (tm) return <ActionsTrace id={decodeURIComponent(tm[1])} testId={decodeURIComponent(tm[2])} />;
  const rm = /^runs\/([^/]+)$/.exec(path);
  if (rm) return <DetailView key={rm[1]} id={decodeURIComponent(rm[1])} status={status} />;
  const qm = /^requests\/([^/]+)$/.exec(path);
  if (qm) return <RequestView key={qm[1]} request={decodeURIComponent(qm[1])} status={status} />;
  if (path === 'setup') return <SetupView status={status} />;
  return <ListView status={status} />;
}

function targetText(s: ActionsStatus): string {
  const t = s.target;
  if (!t) return '';
  if (t.pr !== undefined) return `#${t.pr}（${t.headRef ?? t.ref ?? ''}・${sha7(t.sha)}）`;
  return `${t.ref ?? ''}・${sha7(t.sha)}`;
}

// --- Actions の実行一覧 ---

function ListView({ status }: { status: ActionsStatus }) {
  const { config } = useApp();
  const [list, setList] = useState<ActionsRunList | null>(null);
  const [listError, setListError] = useState('');
  const [runner, setRunner] = useState('');
  const [ids, setIds] = useState(() => (pendingDispatch ? pendingDispatch.join(', ') : ''));
  const [error, setError] = useState<{ text: string; url?: string } | null>(() => {
    const f = listFlash;
    listFlash = null;
    return f;
  });
  const [busy, setBusy] = useState(false);
  const dispatchGate = useGate('actionsDispatch');

  const reload = useCallback(() => {
    actionsApi
      .runs()
      .then((l) => {
        setList(l);
        setListError('');
      })
      .catch((e: Error) => setListError(e.message));
  }, []);

  useEffect(() => {
    reload();
    return onActionsEvent((e) => {
      if (e.type === 'history' || e.state !== 'Dispatching') reload();
    });
  }, [reload]);

  const dispatch = useCallback(
    async (idList: string[], rows: ActionsRunRow[]) => {
      const queued = rows.find((r) => r.state === 'queued');
      if (queued && !window.confirm(ACTIONS_TEXT.queuedConfirm(queued.request ?? queued.actionsRunId))) return;
      const waiting = rows.some((r) => r.state === 'in_progress');
      setBusy(true);
      setError(null);
      try {
        const { request } = await actionsApi.dispatch({ ...(idList.length ? { ids: idList } : {}), ...(runner ? { runner } : {}) });
        dispatchedAt.set(request, Date.now());
        if (waiting) waitNotes.add(request);
        location.hash = actionsHref(`requests/${encodeURIComponent(request)}`);
      } catch (e) {
        setError({ text: (e as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [runner],
  );

  // A matrix row's 「Actionsで実行」: dispatch once the list is known.
  useEffect(() => {
    if (!pendingDispatch || !list || status.state !== 'ready') return;
    const p = pendingDispatch;
    pendingDispatch = null;
    void dispatch(p, list.rows);
  }, [list, status.state, dispatch]);

  const ready = status.state === 'ready';
  const fork = status.state === 'fork';
  const reason: { text: string; url?: string } | null = !ready && status.reason ? { text: status.reason } : null;
  const shown = error ?? reason;
  const local = !workspace() && status.canInit;

  return (
    <div className="tests-page actions-page" data-testid="actions-list">
      <TestsTabs actions />
      {status.state === 'setup' && (
        <div className="notice warn actions-banner">
          {status.reason}{' '}
          <button type="button" data-testid="setup-open" onClick={() => (location.hash = actionsHref('setup'))}>
            導入の案内
          </button>
        </div>
      )}
      <div className="row">
        <strong>Actions</strong>
        <span className="muted">ddv ワークフロー：ddv-tests.yml</span>
        <span className="muted" data-testid="target">
          {targetText(status)}
        </span>
        <span className="spacer" />
        <button type="button" data-testid="setup-open" onClick={() => (location.hash = actionsHref('setup'))}>
          導入の案内
        </button>
      </div>
      <div className="row toolbar">
        <label>
          ランナー{' '}
          <select value={runner} onChange={(e) => setRunner(e.target.value)} data-testid="runner">
            <option value="">すべて</option>
            {(config?.runners ?? []).map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          テストID（空欄で全件）{' '}
          <input value={ids} onChange={(e) => setIds(e.target.value)} maxLength={4000} data-testid="ids" />
        </label>
        {!fork && (
          <button
            type="button"
            className="primary"
            disabled={!ready || busy || !list || !dispatchGate.enabled}
            title={ready ? dispatchGate.reason : status.reason}
            onClick={() => void dispatch(splitIds(ids), list?.rows ?? [])}
            data-testid="dispatch"
          >
            Actionsで実行
          </button>
        )}
        {ready && !fork && <GateReason gate={dispatchGate} />}
      </div>
      {shown && (
        <div className="notice warn" data-testid="dispatch-error">
          {shown.text}
          {shown.url && (
            <>
              {' '}
              <a href={shown.url} target="_blank" rel="noreferrer">
                Actions の画面
              </a>
            </>
          )}
        </div>
      )}
      {local && status.target && (
        <p className={status.target.dirty ? 'notice warn' : 'muted'} data-testid="uncommitted-note" data-dirty={status.target.dirty ? 'true' : 'false'}>
          {ACTIONS_TEXT.uncommitted(sha7(status.target.sha))}
        </p>
      )}
      {listError && <div className="notice error">{listError}</div>}
      {list?.index.message && (
        <p className="notice" data-testid="index-state" data-state={list.index.state}>
          {list.index.message}
        </p>
      )}
      {fork && list && (
        <div data-testid="ci-checks">
          <h3>PR の CI</h3>
          {list.checks?.length ? (
            <ul>
              {list.checks.map((c, i) => (
                <li key={i}>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.name}
                  </a>{' '}
                  {c.conclusion ?? c.status}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{ACTIONS_TEXT.noChecks}</p>
          )}
        </div>
      )}
      {list && list.rows.length > 0 && (
        <table className="tests-table" data-testid="runs">
          <thead>
            <tr>
              <th>日時</th>
              <th>依頼者</th>
              <th>コミット</th>
              <th>状態</th>
              <th>成功 / 失敗</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.rows.map((r) => (
              <RunRow key={r.id} row={r} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RunRow({ row }: { row: ActionsRunRow }) {
  const done = row.state === 'passed' || row.state === 'failed' || row.state === 'error';
  const running = row.state === 'queued' || row.state === 'in_progress';
  const at = fmtAt(row.at);
  const label = row.mode === 'approve' ? `基準画像の更新（${ROW_STATE[row.state]}）` : ROW_STATE[row.state];
  const counts = row.mode === 'test' && done && row.counts ? `${row.counts.passed} / ${row.counts.failed + row.counts.error}` : '—';
  return (
    <tr data-testid="run-row" data-id={row.id} data-state={row.state}>
      <td>
        {done ? (
          <a href={actionsHref(`runs/${encodeURIComponent(row.id)}`)} data-testid="run-open">
            {at}
          </a>
        ) : running ? (
          <a href={actionsHref(`requests/${encodeURIComponent(row.request ?? `run-${row.actionsRunId}`)}`)} data-testid="run-open">
            {at}
          </a>
        ) : (
          <a href={row.url} target="_blank" rel="noreferrer" data-testid="run-open">
            {at}
          </a>
        )}
      </td>
      <td>{row.actor ?? ''}</td>
      <td>
        <code>{sha7(row.commit)}</code>
        {row.pr !== undefined && ` #${row.pr}`}
      </td>
      <td data-testid="run-status" data-state={row.state}>
        {label}
        {row.approvals > 0 && <span className="chip">承認済み</span>}
        {row.trimmed && <span className="chip">詳細は削除済み</span>}
      </td>
      <td className="num">{counts}</td>
      <td>
        <a href={row.url} target="_blank" rel="noreferrer" data-testid="actions-link">
          Actions
        </a>
      </td>
    </tr>
  );
}

// --- 導入の案内 ---

function SetupView({ status }: { status: ActionsStatus }) {
  const [result, setResult] = useState('');
  const [differs, setDiffers] = useState<{ text: string; diff: string } | null>(null);
  const [error, setError] = useState('');
  const branch = status.defaultBranch ?? '既定ブランチ';
  const init = async (force: boolean) => {
    setError('');
    try {
      const r = await actionsApi.init(force);
      setDiffers(null);
      setResult(r.status === 'unchanged' ? ACTIONS_TEXT.unchanged : ACTIONS_TEXT.placed(r.path));
      void loadActionsStatus(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'workflow-differs') setDiffers({ text: e.message, diff: String(e.body?.diff ?? '') });
      else setError((e as Error).message);
    }
  };
  return (
    <div className="tests-page actions-page" data-testid="actions-setup">
      <div className="row">
        <button type="button" data-testid="setup-back" onClick={() => (location.hash = actionsHref())}>
          ← 一覧へ
        </button>
        <strong>ddv ワークフローの導入</strong>
      </div>
      <ol data-testid="setup-steps">
        <li>
          <code>ddv actions init</code> で <code>.github/workflows/ddv-tests.yml</code> を配置（ローカル版は下のボタンでも可）
        </li>
        <li>コミットして既定ブランチ（{branch}）にマージ</li>
        <li>
          ビューアの「Actionsで実行」から実行（結果は <code>ddv-results</code> ブランチに保存）
        </li>
      </ol>
      {status.canInit && (
        <div className="row">
          <button type="button" data-testid="setup-init" onClick={() => void init(false)}>
            配置する
          </button>
        </div>
      )}
      {differs && (
        <div className="notice warn" data-testid="setup-differs">
          {differs.text}
          <pre className="log">{differs.diff}</pre>
          <button type="button" data-testid="setup-force" onClick={() => void init(true)}>
            上書きする
          </button>
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
      {result && (
        <p className="notice" data-testid="setup-result">
          {result}
        </p>
      )}
      <p className="muted">保持の既定：200 件・90 日・トレース 20 回分（ワークフローの入力で変更）</p>
    </div>
  );
}

// --- 起動中・実行中・基準画像の更新中 ---

function useTracker(request: string): TrackerUpdate | undefined {
  const [u, setU] = useState(() => trackerOf(request));
  useEffect(() => {
    setU(trackerOf(request));
    return onActionsEvent((e) => {
      if (e.type === 'tracker' && e.request === request) setU(e);
    });
  }, [request]);
  return u;
}

function useSeconds(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function RequestView({ request, status }: { request: string; status: ActionsStatus }) {
  const u = useTracker(request);
  const now = useSeconds();
  const [mounted] = useState(Date.now());
  const origin = approveOrigin.get(request);
  const approve = u?.mode === 'approve' || origin !== undefined;

  useEffect(() => {
    if (!u) return;
    if (u.mode === 'approve') {
      const back = () => (location.hash = origin ? actionsHref(`runs/${encodeURIComponent(origin)}`) : actionsHref());
      if (u.state === 'Failed') {
        if (origin) approveFlash.set(origin, { error: u.error ?? ACTIONS_TEXT.dispatchFailed });
        back();
      } else if (u.state === 'Cancelled' || (u.state === 'Completed' && u.conclusion === 'cancelled')) {
        if (origin) approveFlash.set(origin, { error: ACTIONS_TEXT.cancelled });
        back();
      } else if (u.state === 'Completed' && (u.approveCommit !== undefined || u.error)) {
        if (origin) approveFlash.set(origin, u.error ? { error: u.error } : { commit: u.approveCommit });
        back();
      } else if (u.state === 'Stopped') back();
      return;
    }
    if (u.state === 'Failed') {
      listFlash = { text: u.error ?? ACTIONS_TEXT.dispatchFailed, url: status.workflowUrl };
      location.hash = actionsHref();
    } else if (u.state === 'Cancelled' || (u.state === 'Completed' && u.conclusion === 'cancelled')) {
      listFlash = { text: ACTIONS_TEXT.cancelled };
      location.hash = actionsHref();
    } else if (u.state === 'Completed' && u.resultId) {
      location.hash = actionsHref(`runs/${encodeURIComponent(u.resultId)}`);
    } else if (u.state === 'Stopped') location.hash = actionsHref();
  }, [u, origin, status.workflowUrl]);

  const started = (u && Date.parse(u.startedAt)) || dispatchedAt.get(request) || mounted;
  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const requestText = (
    <p data-testid="request">
      依頼ID {request}（経過 {elapsed} 秒）
    </p>
  );

  if (approve)
    return (
      <div className="tests-page actions-page" data-testid="actions-approving">
        <strong>基準画像の更新中</strong>
        <p data-testid="approve-status">{ACTIONS_TEXT.approveStatus(status.target?.headRef ?? status.target?.ref ?? '')}</p>
        {requestText}
        {u?.jobs && <Jobs jobs={u.jobs} />}
        {u?.url && (
          <a href={u.url} target="_blank" rel="noreferrer" data-testid="logs-link">
            Actions のログ
          </a>
        )}
      </div>
    );

  if (!u || u.state === 'Dispatching')
    return (
      <div className="tests-page actions-page" data-testid="actions-dispatching">
        <strong>起動中</strong>
        {requestText}
        {waitNotes.has(request) && <p className="muted">{ACTIONS_TEXT.waitPrevious}</p>}
      </div>
    );

  return (
    <div className="tests-page actions-page" data-testid="actions-running">
      <div className="row">
        <button type="button" data-testid="running-back" onClick={() => (location.hash = actionsHref())}>
          ← 一覧へ
        </button>
        <strong>実行中</strong>
        {u.url && (
          <a href={u.url} target="_blank" rel="noreferrer" data-testid="logs-link">
            Actions のログ
          </a>
        )}
      </div>
      {requestText}
      <div data-testid="steps">
        {u.jobs?.length ? <Jobs jobs={u.jobs} /> : <p className="muted">ジョブの開始を待っています</p>}
        {u.state === 'Running' && u.error && <p className="muted">{ACTIONS_TEXT.pollError}</p>}
      </div>
    </div>
  );
}

function mark(status: string, conclusion?: string): string {
  if (status === 'completed') return conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral' ? '✔' : '✖';
  return status === 'in_progress' ? '…' : '・';
}

function Jobs({ jobs }: { jobs: NonNullable<TrackerUpdate['jobs']> }) {
  return (
    <ul className="steps">
      {jobs.map((j) => (
        <li key={j.name}>
          {mark(j.status, j.conclusion)} {j.name}
          {j.steps.length > 0 && (
            <ul>
              {j.steps.map((s) => (
                <li key={s.number}>
                  {mark(s.status, s.conclusion)} {s.name}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

// --- 実行の結果 ---

const RANK: Record<string, number> = { failed: 0, error: 0, skipped: 1, passed: 1 };
const SHOT_LABEL = { baseline: '基準', current: '今回', diff: '差分' } as const;

function DetailView({ id, status }: { id: string; status: ActionsStatus }) {
  const [d, setD] = useState<ActionsRunDetail | null>(null);
  const [error, setError] = useState('');
  const [flash] = useState(() => {
    const f = approveFlash.get(id);
    approveFlash.delete(id);
    return f;
  });
  const [approveError, setApproveError] = useState(flash?.error ?? '');
  const [off, setOff] = useState<Set<string>>(new Set());
  const approveGate = useGate('snapshotApprove');

  useEffect(() => {
    actionsApi
      .run(id)
      .then(setD)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const results = useMemo(() => {
    const r = d?.record?.results ?? {};
    return Object.entries(r).sort(([a, x], [b, y]) => (RANK[x.status] ?? 1) - (RANK[y.status] ?? 1) || a.localeCompare(b));
  }, [d]);

  const back = (
    <button type="button" data-testid="detail-back" onClick={() => (location.hash = actionsHref())}>
      ← 一覧へ
    </button>
  );
  if (!d)
    return (
      <div className="tests-page actions-page" data-testid="actions-detail">
        <div className="row">{back}</div>
        {error ? <div className="notice error">{error}</div> : <p className="muted">読み込み中…</p>}
      </div>
    );

  const diffs = d.snapshots.filter((s) => s.steps.some((st) => st.status === 'Diff' || st.status === 'NoBase'));
  const selected = diffs.map((s) => s.id).filter((x) => !off.has(x));
  const counts = d.record ? Object.values(d.record.results) : [];
  const passed = counts.filter((r) => r.status === 'passed').length;
  const failed = counts.filter((r) => r.status === 'failed' || r.status === 'error').length;
  const blocked = !selected.length
    ? ACTIONS_TEXT.approveIds
    : status.state !== 'ready'
      ? status.reason
      : !approveGate.enabled
        ? (approveGate.reason ?? '')
        : status.target?.pr === undefined
          ? ACTIONS_TEXT.notPr
          : d.trimmed
            ? ACTIONS_TEXT.trimmed
            : '';
  const commitUrl = (sha: string) => `https://github.com/${status.repo ?? ''}/commit/${sha}`;

  const approve = async () => {
    setApproveError('');
    try {
      const { request } = await actionsApi.approve(id, selected);
      approveOrigin.set(request, id);
      dispatchedAt.set(request, Date.now());
      location.hash = actionsHref(`requests/${encodeURIComponent(request)}`);
    } catch (e) {
      setApproveError((e as Error).message);
    }
  };

  return (
    <div className="tests-page actions-page" data-testid="actions-detail">
      <div className="row">
        {back}
        <strong>{fmtAt(d.info.createdAt)} の実行</strong>
        <span className="chip" data-testid="detail-source">
          Actions
        </span>
        <span className="muted">
          {sha7(d.info.sha)}
          {d.record && `・${passed} / ${failed}`}
        </span>
        <a href={d.info.url} target="_blank" rel="noreferrer">
          Actions
        </a>
      </div>
      {d.recordState === 'ok' ? (
        <table className="tests-table" data-testid="results">
          <thead>
            <tr>
              <th>テストID</th>
              <th>結果</th>
              <th>メッセージ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {results.map(([tid, r]) => (
              <tr key={tid} data-testid="result-row" data-test-id={tid}>
                <td>
                  <code className="test-id">{tid}</code>
                </td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="fail-msg">{r.message?.split('\n')[0] ?? ''}</td>
                <td>
                  {d.traceOf[tid] && (
                    <button type="button" className="run" data-testid="result-trace" onClick={() => (location.hash = actionsHref(`runs/${encodeURIComponent(id)}/trace/${encodeURIComponent(tid)}`))}>
                      トレース
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="notice warn" data-testid="results" data-state={d.recordState}>
          {d.recordState === 'missing' ? ACTIONS_TEXT.missing : ACTIONS_TEXT.broken}
        </p>
      )}
      {d.warnings.length > 0 && (
        <ul className="notice warn" data-testid="run-warnings">
          {d.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {diffs.length > 0 && (
        <section data-testid="snapshot-diff">
          <h3>スナップショットの差分</h3>
          {d.trimmed && <p className="muted">{ACTIONS_TEXT.trimmedImages}</p>}
          {diffs.map((s) => {
            const steps = s.steps.filter((st) => st.status === 'Diff' || st.status === 'NoBase');
            return (
              <div key={s.id} className="snapshot-scenario">
                <label>
                  <input
                    type="checkbox"
                    data-testid="approve-target"
                    value={s.id}
                    checked={!off.has(s.id)}
                    onChange={() => {
                      const n = new Set(off);
                      if (n.has(s.id)) n.delete(s.id);
                      else n.add(s.id);
                      setOff(n);
                    }}
                  />{' '}
                  {s.id}（{steps.length} 枚に差分）
                </label>
                {!d.trimmed &&
                  steps.map((st) => {
                    const n = String(st.step).padStart(3, '0');
                    const kinds = st.status === 'NoBase' ? (['current'] as const) : (['baseline', 'current', 'diff'] as const);
                    return (
                      <div key={st.step} className="shots">
                        {kinds.map((k) => (
                          <figure key={k}>
                            <ActionsImg id={id} path={`snapshots/${k}/${s.id}/${n}.png`} alt={`${s.id} ${n} ${SHOT_LABEL[k]}`} />
                            <figcaption>
                              {SHOT_LABEL[k]}（ステップ {st.step}）
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    );
                  })}
              </div>
            );
          })}
          <div>
            <button type="button" className="primary" data-testid="approve" disabled={!!blocked} title={blocked || undefined} onClick={() => void approve()}>
              基準画像を承認
            </button>
          </div>
        </section>
      )}
      {approveError && (
        <div className="notice warn" data-testid="approve-error">
          {approveError}
        </div>
      )}
      {(flash?.commit !== undefined || d.approvals.length > 0) && (
        <div data-testid="approve-commit">
          {flash && flash.commit !== undefined && (flash.commit === null ? <p>{ACTIONS_TEXT.noChange}</p> : <a href={commitUrl(flash.commit)} target="_blank" rel="noreferrer">基準画像のコミット {sha7(flash.commit)}</a>)}
          {d.approvals.length > 0 && (
            <ul>
              {d.approvals.map((a, i) => (
                <li key={i}>
                  {fmtAt(a.at)} {a.actor ?? ''} {a.ids.join(', ')}：
                  {a.commit ? (
                    <a href={commitUrl(a.commit)} target="_blank" rel="noreferrer">
                      {sha7(a.commit)}
                    </a>
                  ) : (
                    ACTIONS_TEXT.noChange
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** トレース of an Actions run: read from the results branch (`files/traces/<id>.json`). */
function ActionsTrace({ id, testId }: { id: string; testId: string }) {
  const load = useCallback(
    () =>
      actionsApi.blob(id, `traces/${testId}.json`).then(
        async (b) => JSON.parse(await b.text()) as TraceResponse,
        (e: { status?: number }) => {
          throw new ApiError('トレースがありません', e.status ?? 404, 'missing');
        },
      ),
    [id, testId],
  );
  const shotUrl = useCallback((n: number) => actionsApi.file(id, `traces/${testId}/${n}.png`), [id, testId]);
  const evidence = useCallback<EvidenceLoader>(
    (f, signal) => {
      // Pages: through the backend (path check, 100MB cache, pruned when the results branch dropped it).
      if (api.edition === 'pages') {
        const k = parseResultKey(testId);
        return api.evidence(id, k.testId, k.platform, baseName(f.path), signal);
      }
      return actionsApi.blob(id, `traces/${f.path}`).catch(() => {
        throw new ApiError('古い実行のため証跡は削除されました', 404, 'pruned');
      });
    },
    [id, testId],
  );
  return <TraceView runId={id} testId={testId} load={load} shotUrl={shotUrl} evidence={evidence} backHref={actionsHref(`runs/${encodeURIComponent(id)}`)} />;
}

/** An image of the results branch (the URL resolves asynchronously: Pages makes `blob:` URLs). */
function ActionsImg({ id, path, alt }: { id: string; path: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    actionsApi.file(id, path).then(
      (u) => alive && setSrc(u),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [id, path]);
  return src ? <img src={src} alt={alt} loading="lazy" /> : <span className="muted">{alt}</span>;
}
