import { describe, expect, it } from 'vitest';
import {
  badgesFor,
  desktopWarning,
  hostedTargets,
  initialTargets,
  loadSavedTargets,
  NO_TARGET_MESSAGE,
  openTargetSelect,
  resultsByPlatform,
  saveTargets,
  scenarioCount,
  shouldOpenTargetSelect,
  targetSelectReducer,
  targetProgress,
  type Target,
  type TargetSelectEvent,
  type TargetSelectState,
} from './targets.ts';

const T = (name: string, platform: Target['platform'], available = true, reason?: string): Target => ({ name, platform, target: name, available, ...(reason ? { reason } : {}) });
const TARGETS = [T('e2e', 'web'), T('wpf', 'wpf'), T('winforms', 'winforms', false, 'デスクトップアプリの実行は Windows でだけ行えます')];
const SC = { file: 'docs/mocks/order/scenarios/a.yaml' };
const UNIT = { file: 'packages/x/a.test.ts' };
const CASES = [
  { id: 'A', links: [SC] },
  { id: 'B', links: [UNIT] },
  { id: 'C', links: [] },
];

describe('実行の始め方（DD-PLATRES-RUNOPEN）', () => {
  it('[DD-PLATRES-RUNOPEN-P001] [DD-PLATRES-RUNOPEN-T001] [DD-PLATRES-RUNOPEN-T002] シナリオに紐づくものが無ければそのまま開始', () => {
    expect(shouldOpenTargetSelect(['B', 'C'], CASES, 3)).toBe(false);
    expect(shouldOpenTargetSelect([], CASES, 3)).toBe(false);
  });
  it('[DD-PLATRES-RUNOPEN-P002] [DD-PLATRES-RUNOPEN-T003] [DD-PLATRES-RUNOPEN-T004] 接続先が 1 つ以下ならそのまま開始（Web だけのリポジトリ）', () => {
    expect(shouldOpenTargetSelect(['A', 'B'], CASES, 1)).toBe(false);
    expect(shouldOpenTargetSelect(['A'], CASES, 0)).toBe(false);
  });
  it('[DD-PLATRES-RUNOPEN-P003] [DD-PLATRES-RUNOPEN-T005] 接続先が 2 つ以上なら接続先の選択を開く', () => {
    expect(shouldOpenTargetSelect(['A', 'B'], CASES, 2)).toBe(true);
    expect(scenarioCount(['A', 'B', 'C'], CASES)).toBe(1);
  });
});

describe('Pages 版の接続先（BD-DESKRUN-GATE）', () => {
  it('[BD-DESKRUN-GATE-P002] [BD-DESKRUN-GATE-T004] [BD-DESKRUN-GATE-S003] Pages 版ではデスクトップの接続先を無効にし、理由を出す', () => {
    const t = hostedTargets(
      [
        { name: 'e2e', type: 'playwright', scenarios: {} },
        { name: 'unit', type: 'vitest' },
        { name: 'wpf', type: 'flaui', platform: 'wpf', app: { path: 'a.exe' } },
      ],
      'docs/mocks',
    );
    expect(t).toEqual([
      { name: 'e2e', platform: 'web', target: 'モック（docs/mocks）', available: true },
      { name: 'wpf', platform: 'wpf', target: 'a.exe', available: false, code: 'hosted', reason: 'デスクトップアプリの実行はローカル版（Windows）で行います' },
    ]);
  });
});

describe('前回の選択', () => {
  it('保存した名前のうち使えるもの・無ければ使える web・それも無ければ空', () => {
    expect(initialTargets(TARGETS, ['wpf', 'winforms'])).toEqual(['wpf']);
    expect(initialTargets(TARGETS, ['winforms'])).toEqual(['e2e']);
    expect(initialTargets(TARGETS, null)).toEqual(['e2e']);
    expect(initialTargets([T('e2e', 'web', false), T('wpf', 'wpf')], null)).toEqual([]);
  });
  it('localStorage の ddv.targets.<ワークスペースID> に保存して読み直す（壊れた値は無視）', () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveTargets(st, 'local', ['e2e', 'wpf']);
    expect(m.get('ddv.targets.local')).toBe('["e2e","wpf"]');
    expect(loadSavedTargets(st, 'local')).toEqual(['e2e', 'wpf']);
    m.set('ddv.targets.x', '{');
    expect(loadSavedTargets(st, 'x')).toBeNull();
  });
});

// Events of the state diagram.
const EV: Record<string, TargetSelectEvent> = {
  成功: { type: 'loaded', targets: TARGETS, saved: null },
  失敗: { type: 'loadFailed', error: 'HTTP 500' },
  開き直す: { type: 'reopen' },
  開始: { type: 'start' },
  '400': { type: 'rejected', error: '同じプラットフォームの接続先は 1 回の実行で 1 つまでです' },
  '202': { type: 'started', runId: 'r1' },
  キャンセル: { type: 'cancel' },
};
const choosing = (selected: string[]): TargetSelectState => ({ kind: 'Choosing', targets: TARGETS, selected, error: '' });
const STATES: Record<string, TargetSelectState> = {
  読み込み中: openTargetSelect(),
  選択: choosing(['e2e']),
  読み込みの失敗: { kind: 'LoadError', error: '接続先を読み込めません: HTTP 500' },
  開始中: { kind: 'Starting', targets: TARGETS, selected: ['e2e'] },
};
const KIND: Record<string, TargetSelectState['kind']> = { 読み込み中: 'Loading', 選択: 'Choosing', 読み込みの失敗: 'LoadError', 開始中: 'Starting', 終了: 'Closed' };

describe('接続先の選択の状態（DD-PLATRES-TSEL）', () => {
  it('[DD-PLATRES-TSEL-T001] 開くと読み込み中', () => {
    expect(openTargetSelect()).toEqual({ kind: 'Loading' });
  });
  it('[DD-PLATRES-TSEL-T002] 読み込みに成功すると選択（前回の選択を初期値に）', () => {
    expect(targetSelectReducer(STATES.読み込み中, { type: 'loaded', targets: TARGETS, saved: ['wpf'] })).toEqual(choosing(['wpf']));
  });
  it('[DD-PLATRES-TSEL-T003] 読み込みに失敗すると「接続先を読み込めません: <理由>」', () => {
    expect(targetSelectReducer(STATES.読み込み中, EV.失敗)).toEqual(STATES.読み込みの失敗);
  });
  it('[DD-PLATRES-TSEL-T004] 開き直すと読み込み中', () => {
    expect(targetSelectReducer(STATES.読み込みの失敗, EV.開き直す)).toEqual({ kind: 'Loading' });
  });
  it('[DD-PLATRES-TSEL-T005] 選んでいないと要求を送らず「接続先を選んでください」', () => {
    const s = targetSelectReducer(choosing([]), EV.開始);
    expect(s).toEqual({ ...choosing([]), error: NO_TARGET_MESSAGE });
  });
  it('[DD-PLATRES-TSEL-T006] 選んでいれば開始中', () => {
    expect(targetSelectReducer(choosing(['e2e', 'wpf']), EV.開始)).toEqual({ kind: 'Starting', targets: TARGETS, selected: ['e2e', 'wpf'] });
  });
  it('[DD-PLATRES-TSEL-T007] 400 / 409 は応答の error を出し、選択を残す', () => {
    const s = targetSelectReducer({ kind: 'Starting', targets: TARGETS, selected: ['wpf'] }, { type: 'rejected', error: 'wpf は使えません: x' });
    expect(s).toEqual({ kind: 'Choosing', targets: TARGETS, selected: ['wpf'], error: 'wpf は使えません: x' });
  });
  it('[DD-PLATRES-TSEL-T008] 202 で閉じる（開始した接続先を残す）', () => {
    expect(targetSelectReducer(STATES.開始中, EV['202'])).toEqual({ kind: 'Closed', runId: 'r1', selected: ['e2e'] });
  });
  it('[DD-PLATRES-TSEL-T009] 選択でキャンセルすると閉じる', () => {
    expect(targetSelectReducer(STATES.選択, EV.キャンセル)).toEqual({ kind: 'Closed' });
  });
  it('[DD-PLATRES-TSEL-T010] 読み込みの失敗でキャンセルすると閉じる', () => {
    expect(targetSelectReducer(STATES.読み込みの失敗, EV.キャンセル)).toEqual({ kind: 'Closed' });
  });
  it('使えない接続先は押せない・選んだ順は設定の順', () => {
    const s = targetSelectReducer(targetSelectReducer(choosing([]), { type: 'toggle', name: 'winforms' }), { type: 'toggle', name: 'wpf' });
    expect(s).toMatchObject({ selected: ['wpf'] });
    expect(targetSelectReducer(s, { type: 'toggle', name: 'e2e' })).toMatchObject({ selected: ['e2e', 'wpf'] });
    expect(desktopWarning(TARGETS, ['e2e'])).toBeNull();
    expect(desktopWarning(TARGETS, ['e2e', 'wpf'])).toContain('マウス・キーボードに触れないでください');
  });
  it('接続先の進捗をログの見出しから「実行中 / 待ち / 完了」にする', () => {
    const log = ['── e2e (playwright, integration) ──', '[e2e] ok', '── wpf (flaui, integration) ──'];
    expect(targetProgress(['e2e', 'wpf', 'winforms'], log, false).map((p) => p.state)).toEqual(['完了', '実行中', '待ち']);
    expect(targetProgress(['e2e', 'wpf'], log, true).map((p) => p.state)).toEqual(['完了', '完了']);
  });

  // Paths: [event label, selection before 開始 ('none' = nothing chosen)].
  const PATHS: Array<[string, string[]]> = [
    ['P001', ['成功', '開始:none', '開始', '202']],
    ['P002', ['成功', '開始:none', 'キャンセル']],
    ['P003', ['成功', '開始', '400', '開始', '202']],
    ['P004', ['成功', '開始', '400', 'キャンセル']],
    ['P005', ['成功', '開始', '202']],
    ['P006', ['成功', 'キャンセル']],
    ['P007', ['失敗', '開き直す', '成功', '開始:none', '開始', '202']],
    ['P008', ['失敗', '開き直す', '成功', '開始:none', 'キャンセル']],
    ['P009', ['失敗', '開き直す', '成功', '開始', '400', '開始', '202']],
    ['P010', ['失敗', '開き直す', '成功', '開始', '400', 'キャンセル']],
    ['P011', ['失敗', '開き直す', '成功', '開始', '202']],
    ['P012', ['失敗', '開き直す', '成功', 'キャンセル']],
    ['P013', ['失敗', '開き直す', '失敗', 'キャンセル']],
    ['P014', ['失敗', 'キャンセル']],
  ];
  it.each(PATHS)('[DD-PLATRES-TSEL-%s] 経路をたどって閉じる', (_id, steps) => {
    let s = openTargetSelect();
    for (const step of steps) {
      if (step === '開始:none') {
        if (s.kind === 'Choosing') s = { ...s, selected: [] };
        const before = s;
        s = targetSelectReducer(s, EV.開始);
        expect(s).toEqual({ ...before, error: NO_TARGET_MESSAGE });
        s = targetSelectReducer(s, { type: 'toggle', name: 'e2e' });
        continue;
      }
      s = targetSelectReducer(s, EV[step]);
    }
    expect(s.kind).toBe(KIND.終了);
  });
  // Literal ids for the scanner.
  it('[DD-PLATRES-TSEL-P001][DD-PLATRES-TSEL-P002][DD-PLATRES-TSEL-P003][DD-PLATRES-TSEL-P004][DD-PLATRES-TSEL-P005][DD-PLATRES-TSEL-P006][DD-PLATRES-TSEL-P007] 経路の一覧（前半）', () => {
    expect(PATHS.slice(0, 7).map(([id]) => id)).toEqual(['P001', 'P002', 'P003', 'P004', 'P005', 'P006', 'P007']);
  });
  it('[DD-PLATRES-TSEL-P008][DD-PLATRES-TSEL-P009][DD-PLATRES-TSEL-P010][DD-PLATRES-TSEL-P011][DD-PLATRES-TSEL-P012][DD-PLATRES-TSEL-P013][DD-PLATRES-TSEL-P014] 経路の一覧（後半）', () => {
    expect(PATHS.slice(7).map(([id]) => id)).toEqual(['P008', 'P009', 'P010', 'P011', 'P012', 'P013', 'P014']);
  });

  const INVALID: Array<[string, string, string]> = [
    ['X001', '読み込み中', '開き直す'],
    ['X002', '読み込み中', '開始'],
    ['X003', '読み込み中', '400'],
    ['X004', '読み込み中', '202'],
    ['X005', '読み込み中', 'キャンセル'],
    ['X006', '選択', '成功'],
    ['X007', '選択', '失敗'],
    ['X008', '選択', '開き直す'],
    ['X009', '選択', '400'],
    ['X010', '選択', '202'],
    ['X011', '読み込みの失敗', '成功'],
    ['X012', '読み込みの失敗', '失敗'],
    ['X013', '読み込みの失敗', '開始'],
    ['X014', '読み込みの失敗', '400'],
    ['X015', '読み込みの失敗', '202'],
    ['X016', '開始中', '成功'],
    ['X017', '開始中', '失敗'],
    ['X018', '開始中', '開き直す'],
    ['X019', '開始中', '開始'],
    ['X020', '開始中', 'キャンセル'],
  ];
  it('[DD-PLATRES-TSEL-X001][DD-PLATRES-TSEL-X002][DD-PLATRES-TSEL-X003][DD-PLATRES-TSEL-X004][DD-PLATRES-TSEL-X005][DD-PLATRES-TSEL-X006][DD-PLATRES-TSEL-X007][DD-PLATRES-TSEL-X008][DD-PLATRES-TSEL-X009][DD-PLATRES-TSEL-X010] 図に無い操作は受け付けない（前半）', () => {
    for (const [, st, ev] of INVALID.slice(0, 10)) expect(targetSelectReducer(STATES[st], EV[ev])).toBe(STATES[st]);
  });
  it('[DD-PLATRES-TSEL-X011][DD-PLATRES-TSEL-X012][DD-PLATRES-TSEL-X013][DD-PLATRES-TSEL-X014][DD-PLATRES-TSEL-X015][DD-PLATRES-TSEL-X016][DD-PLATRES-TSEL-X017][DD-PLATRES-TSEL-X018][DD-PLATRES-TSEL-X019][DD-PLATRES-TSEL-X020] 図に無い操作は受け付けない（後半）', () => {
    for (const [, st, ev] of INVALID.slice(10)) expect(targetSelectReducer(STATES[st], EV[ev])).toBe(STATES[st]);
  });
});

describe('バッジの表示（DD-PLATRES-BADGE）', () => {
  const ok = { status: 'passed' as const, runId: 'r1', trace: true };
  it('[DD-PLATRES-BADGE-P001] [DD-PLATRES-BADGE-T001] [DD-PLATRES-BADGE-T002] [DD-PLATRES-BADGE-T003] web だけ・空ならバッジを出さない', () => {
    expect(badgesFor('A', ['web'], { web: ok })).toBeNull();
    expect(badgesFor('A', [], {})).toBeNull();
  });
  it('[DD-PLATRES-BADGE-P002] [DD-PLATRES-BADGE-T004] [DD-PLATRES-BADGE-T005] [DD-PLATRES-BADGE-T006] 結果の無いプラットフォームは「–」で押せない', () => {
    const b = badgesFor('A', ['web', 'wpf'], { web: ok })!;
    expect(b.map((x) => x.label)).toEqual(['web ✓', 'wpf –']);
    expect(b[1]).toMatchObject({ trace: null });
  });
  it('[DD-PLATRES-BADGE-P003] [DD-PLATRES-BADGE-T007] [DD-PLATRES-BADGE-T008] トレースがあれば ✓ / ✗ でトレースへ', () => {
    const b = badgesFor('A', ['web'], { wpf: { status: 'failed', runId: 'r2', trace: true } })!;
    expect(b.map((x) => x.platform)).toEqual(['web', 'wpf']);
    expect(b[1]).toMatchObject({ mark: '✗', trace: { runId: 'r2', testId: 'A', platform: 'wpf' } });
  });
  it('[DD-PLATRES-BADGE-P004] [DD-PLATRES-BADGE-T009] トレースが無ければ ✓ / ✗ で押せない', () => {
    const b = badgesFor('A', ['winforms', 'web'], { winforms: { status: 'passed', runId: 'r3', trace: false } })!;
    expect(b.map((x) => x.platform)).toEqual(['web', 'winforms']);
    expect(b[1]).toMatchObject({ mark: '✓', trace: null, title: 'トレースはありません' });
  });
  it('最新の結果のキーをテストIDごとに束ねる', () => {
    expect(resultsByPlatform({ A: ok, 'A@wpf': ok, B: ok, 'A@x': ok }, 'A')).toEqual({ web: ok, wpf: ok });
  });
});
