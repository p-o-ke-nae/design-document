import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILD_FAILED,
  FrameSession,
  NO_RESPONSE,
  RESPONSE_TIMEOUT_MS,
  VERSION_MISMATCH,
  createFrameTransport,
  frameSessionTransition,
  type Edition,
  type FrameSessionEvent,
  type FrameSessionState,
  type MockMessage,
} from './player.ts';

const STATES: FrameSessionState[] = ['Building', 'Loading', 'Initializing', 'Ready', 'Running', 'Failed'];

function expectT(from: FrameSessionState | null, event: FrameSessionEvent, editions: Edition[], to: FrameSessionState) {
  for (const ed of editions) expect(frameSessionTransition(from, event, ed), `${ed}`).toBe(to);
}
function expectX(from: FrameSessionState, event: FrameSessionEvent) {
  for (const ed of ['pages', 'local'] as const) expect(frameSessionTransition(from, event, ed), `${ed}`).toBeNull();
}

describe('frameSessionTransition (DD-MOCKSB-HANDSHAKE)', () => {
  it('[DD-MOCKSB-HANDSHAKE-T001] 開始 表示 Pages→ 組み立て中', () => expectT(null, 'show', ["pages"], 'Building'));
  it('[DD-MOCKSB-HANDSHAKE-T002] 開始 表示 ローカル→ 読み込み中', () => expectT(null, 'show', ["local"], 'Loading'));
  it('[DD-MOCKSB-HANDSHAKE-T003] 組み立て中 組み立て完了→ 読み込み中', () => expectT("Building", 'built', ["pages","local"], 'Loading'));
  it('[DD-MOCKSB-HANDSHAKE-T004] 組み立て中 組み立て失敗→ 失敗', () => expectT("Building", 'buildFailed', ["pages","local"], 'Failed'));
  it('[DD-MOCKSB-HANDSHAKE-T005] 読み込み中 ddv:hello Pages→ 初期化中', () => expectT("Loading", 'hello', ["pages"], 'Initializing'));
  it('[DD-MOCKSB-HANDSHAKE-T006] 読み込み中 ddv:ready ローカル→ 待機', () => expectT("Loading", 'ready', ["local"], 'Ready'));
  it('[DD-MOCKSB-HANDSHAKE-T007] 読み込み中 応答なし Pages→ 失敗', () => expectT("Loading", 'timeout', ["pages"], 'Failed'));
  it('[DD-MOCKSB-HANDSHAKE-T008] 初期化中 ddv:ready→ 待機', () => expectT("Initializing", 'ready', ["pages","local"], 'Ready'));
  it('[DD-MOCKSB-HANDSHAKE-T009] 初期化中 ddv:error→ 失敗', () => expectT("Initializing", 'error', ["pages","local"], 'Failed'));
  it('[DD-MOCKSB-HANDSHAKE-T010] 初期化中 応答なし→ 失敗', () => expectT("Initializing", 'timeout', ["pages","local"], 'Failed'));
  it('[DD-MOCKSB-HANDSHAKE-T011] 待機 ddv:step を送る→ 実行中', () => expectT("Ready", 'step', ["pages","local"], 'Running'));
  it('[DD-MOCKSB-HANDSHAKE-T012] 実行中 ddv:result→ 待機', () => expectT("Running", 'result', ["pages","local"], 'Ready'));
  it('[DD-MOCKSB-HANDSHAKE-T013] 待機 ddv:hello Pages→ 初期化中', () => expectT("Ready", 'hello', ["pages"], 'Initializing'));
  it('[DD-MOCKSB-HANDSHAKE-T014] 実行中 ddv:hello Pages→ 初期化中', () => expectT("Running", 'hello', ["pages"], 'Initializing'));
  it('[DD-MOCKSB-HANDSHAKE-T015] 待機 再読込 Pages→ 組み立て中', () => expectT("Ready", 'reload', ["pages"], 'Building'));
  it('[DD-MOCKSB-HANDSHAKE-T016] 実行中 再読込 Pages→ 組み立て中', () => expectT("Running", 'reload', ["pages"], 'Building'));
  it('[DD-MOCKSB-HANDSHAKE-T017] 失敗 再読込 Pages→ 組み立て中', () => expectT("Failed", 'reload', ["pages"], 'Building'));
  it('[DD-MOCKSB-HANDSHAKE-T018] 待機 再読込 ローカル→ 読み込み中', () => expectT("Ready", 'reload', ["local"], 'Loading'));
  it('[DD-MOCKSB-HANDSHAKE-T019] 実行中 再読込 ローカル→ 読み込み中', () => expectT("Running", 'reload', ["local"], 'Loading'));
  it('[DD-MOCKSB-HANDSHAKE-T020] 失敗 再読込 ローカル→ 読み込み中', () => expectT("Failed", 'reload', ["local"], 'Loading'));
  it('[DD-MOCKSB-HANDSHAKE-X001] 組み立て中 で ddv:helloは無視', () => expectX('Building', 'hello'));
  it('[DD-MOCKSB-HANDSHAKE-X002] 組み立て中 で ddv:readyは無視', () => expectX('Building', 'ready'));
  it('[DD-MOCKSB-HANDSHAKE-X003] 組み立て中 で 応答なしは無視', () => expectX('Building', 'timeout'));
  it('[DD-MOCKSB-HANDSHAKE-X004] 組み立て中 で ddv:errorは無視', () => expectX('Building', 'error'));
  it('[DD-MOCKSB-HANDSHAKE-X005] 組み立て中 で ddv:step を送るは無視', () => expectX('Building', 'step'));
  it('[DD-MOCKSB-HANDSHAKE-X006] 組み立て中 で ddv:resultは無視', () => expectX('Building', 'result'));
  it('[DD-MOCKSB-HANDSHAKE-X007] 組み立て中 で 再読込は無視', () => expectX('Building', 'reload'));
  it('[DD-MOCKSB-HANDSHAKE-X008] 読み込み中 で 組み立て完了は無視', () => expectX('Loading', 'built'));
  it('[DD-MOCKSB-HANDSHAKE-X009] 読み込み中 で 組み立て失敗は無視', () => expectX('Loading', 'buildFailed'));
  it('[DD-MOCKSB-HANDSHAKE-X010] 読み込み中 で ddv:errorは無視', () => expectX('Loading', 'error'));
  it('[DD-MOCKSB-HANDSHAKE-X011] 読み込み中 で ddv:step を送るは無視', () => expectX('Loading', 'step'));
  it('[DD-MOCKSB-HANDSHAKE-X012] 読み込み中 で ddv:resultは無視', () => expectX('Loading', 'result'));
  it('[DD-MOCKSB-HANDSHAKE-X013] 読み込み中 で 再読込は無視', () => expectX('Loading', 'reload'));
  it('[DD-MOCKSB-HANDSHAKE-X014] 初期化中 で 組み立て完了は無視', () => expectX('Initializing', 'built'));
  it('[DD-MOCKSB-HANDSHAKE-X015] 初期化中 で 組み立て失敗は無視', () => expectX('Initializing', 'buildFailed'));
  it('[DD-MOCKSB-HANDSHAKE-X016] 初期化中 で ddv:helloは無視', () => expectX('Initializing', 'hello'));
  it('[DD-MOCKSB-HANDSHAKE-X017] 初期化中 で ddv:step を送るは無視', () => expectX('Initializing', 'step'));
  it('[DD-MOCKSB-HANDSHAKE-X018] 初期化中 で ddv:resultは無視', () => expectX('Initializing', 'result'));
  it('[DD-MOCKSB-HANDSHAKE-X019] 初期化中 で 再読込は無視', () => expectX('Initializing', 'reload'));
  it('[DD-MOCKSB-HANDSHAKE-X020] 待機 で 組み立て完了は無視', () => expectX('Ready', 'built'));
  it('[DD-MOCKSB-HANDSHAKE-X021] 待機 で 組み立て失敗は無視', () => expectX('Ready', 'buildFailed'));
  it('[DD-MOCKSB-HANDSHAKE-X022] 待機 で ddv:readyは無視', () => expectX('Ready', 'ready'));
  it('[DD-MOCKSB-HANDSHAKE-X023] 待機 で 応答なしは無視', () => expectX('Ready', 'timeout'));
  it('[DD-MOCKSB-HANDSHAKE-X024] 待機 で ddv:errorは無視', () => expectX('Ready', 'error'));
  it('[DD-MOCKSB-HANDSHAKE-X025] 待機 で ddv:resultは無視', () => expectX('Ready', 'result'));
  it('[DD-MOCKSB-HANDSHAKE-X026] 実行中 で 組み立て完了は無視', () => expectX('Running', 'built'));
  it('[DD-MOCKSB-HANDSHAKE-X027] 実行中 で 組み立て失敗は無視', () => expectX('Running', 'buildFailed'));
  it('[DD-MOCKSB-HANDSHAKE-X028] 実行中 で ddv:readyは無視', () => expectX('Running', 'ready'));
  it('[DD-MOCKSB-HANDSHAKE-X029] 実行中 で 応答なしは無視', () => expectX('Running', 'timeout'));
  it('[DD-MOCKSB-HANDSHAKE-X030] 実行中 で ddv:errorは無視', () => expectX('Running', 'error'));
  it('[DD-MOCKSB-HANDSHAKE-X031] 実行中 で ddv:step を送るは無視', () => expectX('Running', 'step'));
  it('[DD-MOCKSB-HANDSHAKE-X032] 失敗 で 組み立て完了は無視', () => expectX('Failed', 'built'));
  it('[DD-MOCKSB-HANDSHAKE-X033] 失敗 で 組み立て失敗は無視', () => expectX('Failed', 'buildFailed'));
  it('[DD-MOCKSB-HANDSHAKE-X034] 失敗 で ddv:helloは無視', () => expectX('Failed', 'hello'));
  it('[DD-MOCKSB-HANDSHAKE-X035] 失敗 で ddv:readyは無視', () => expectX('Failed', 'ready'));
  it('[DD-MOCKSB-HANDSHAKE-X036] 失敗 で 応答なしは無視', () => expectX('Failed', 'timeout'));
  it('[DD-MOCKSB-HANDSHAKE-X037] 失敗 で ddv:errorは無視', () => expectX('Failed', 'error'));
  it('[DD-MOCKSB-HANDSHAKE-X038] 失敗 で ddv:step を送るは無視', () => expectX('Failed', 'step'));
  it('[DD-MOCKSB-HANDSHAKE-X039] 失敗 で ddv:resultは無視', () => expectX('Failed', 'result'));

  it('ガードの合わない版では遷移しない（ローカル版の ddv:hello・Pages 版の Loading での ddv:ready など）', () => {
    expect(frameSessionTransition(null, 'show', 'local')).toBe('Loading');
    expect(frameSessionTransition('Loading', 'hello', 'local')).toBeNull();
    expect(frameSessionTransition('Ready', 'hello', 'local')).toBeNull();
    expect(frameSessionTransition('Loading', 'ready', 'pages')).toBeNull();
    expect(frameSessionTransition('Loading', 'timeout', 'local')).toBeNull();
    expect(frameSessionTransition(null, 'hello', 'pages')).toBeNull();
    for (const s of STATES) expect(frameSessionTransition(s, 'show', 'pages')).toBeNull();
  });
});

describe('FrameSession', () => {
  it('不正遷移は false で状態を変えず、失敗の文言は Failed のときだけ持つ', async () => {
    const s = new FrameSession('pages');
    const seen: Array<FrameSessionState | null> = [];
    s.subscribe(() => seen.push(s.state));
    expect(s.fire('ready')).toBe(false);
    expect(s.fire('show')).toBe(true);
    expect(s.fire('ready')).toBe(false);
    expect(s.fire('buildFailed', 'x')).toBe(true);
    expect([s.state, s.failure]).toEqual(['Failed', 'x']);
    await expect(s.whenReady()).rejects.toThrow('x');
    s.fire('reload');
    expect([s.state, s.failure]).toEqual(['Building', '']);
    expect(seen).toEqual(['Building', 'Failed', 'Building']);
  });
});

class FakeWin {
  location = { origin: 'http://localhost:5173' };
  private ls = new Set<(e: MessageEvent) => void>();
  addEventListener(_: string, f: (e: MessageEvent) => void) {
    this.ls.add(f);
  }
  removeEventListener(_: string, f: (e: MessageEvent) => void) {
    this.ls.delete(f);
  }
  dispatch(e: Partial<MessageEvent>) {
    for (const f of [...this.ls]) f(e as MessageEvent);
  }
}

function setup(edition: Edition) {
  const win = new FakeWin();
  const posted: Array<{ msg: { type: string } & Record<string, unknown>; origin: string }> = [];
  const frameWin = { postMessage: (msg: { type: string }, origin: string) => posted.push({ msg, origin }) };
  const frame = { contentWindow: frameWin } as unknown as HTMLIFrameElement;
  const messages: MockMessage[] = [];
  const t = createFrameTransport(() => frame, { win: win as unknown as Window, edition, onMessage: (m) => messages.push(m) });
  const origin = edition === 'pages' ? 'null' : win.location.origin;
  const send = (data: Record<string, unknown>, o = origin, source: unknown = frameWin) => win.dispatch({ data, origin: o, source: source as Window });
  const types = () => posted.map((p) => p.msg.type);
  return { win, t, posted, send, types, messages };
}

describe('createFrameTransport（Pages 版）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('組み立て → ddv:hello で ddv:init を 1 回だけ送り、ddv:ready で Ready。reset はそれを待つ', async () => {
    const x = setup('pages');
    expect(x.t.session.state).toBe('Building');
    const reset = x.t.reset(['default']);
    x.t.built({ 'api.yaml': 'base: /api' });
    expect(x.t.session.state).toBe('Loading');
    x.send({ type: 'ddv:hello', protocol: 2, version: '0.1.0' }, 'http://localhost:5173');
    expect(x.t.session.state).toBe('Loading');
    x.send({ type: 'ddv:hello', protocol: 2, version: '0.1.0' }, 'null', {});
    expect(x.t.session.state).toBe('Loading');
    x.send({ type: 'ddv:hello', protocol: 2, version: '0.1.0' });
    expect(x.t.session.state).toBe('Initializing');
    x.send({ type: 'ddv:hello', protocol: 2, version: '0.1.0' });
    expect(x.posted).toEqual([{ msg: { type: 'ddv:init', protocol: 2, files: { 'api.yaml': 'base: /api' } }, origin: '*' }]);
    x.send({ type: 'ddv:ready', screen: 'List', version: '0.1.0', protocol: 2 });
    expect(x.t.session.state).toBe('Ready');
    await vi.advanceTimersByTimeAsync(0);
    expect(x.types()).toEqual(['ddv:init', 'ddv:reset']);
    x.send({ type: 'ddv:ready', screen: 'List', version: '0.1.0', protocol: 2 });
    await expect(reset).resolves.toEqual({ screen: 'List' });

    const step = x.t.step(0, { event: 'open', expect: { screen: 'Detail' } } as never);
    expect(x.t.session.state).toBe('Running');
    x.send({ type: 'ddv:result', index: 0, ok: true, screen: 'Detail', failures: [] });
    await expect(step).resolves.toMatchObject({ ok: true, screen: 'Detail' });
    expect(x.t.session.state).toBe('Ready');
    // Timer of Loading/Initializing is stopped once Ready
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS * 2);
    expect(x.t.session.state).toBe('Ready');
  });

  it('Ready・Running での ddv:hello（モック自身の再読込）は待っているステップを破棄して ddv:init を送り直す', async () => {
    const x = setup('pages');
    x.t.built({});
    x.send({ type: 'ddv:hello', protocol: 2, version: 'v' });
    x.send({ type: 'ddv:ready', screen: null, version: 'v', protocol: 2 });
    const step = x.t.step(0, {} as never);
    x.send({ type: 'ddv:hello', protocol: 2, version: 'v' });
    await expect(step).rejects.toThrow('reset');
    expect(x.t.session.state).toBe('Initializing');
    expect(x.types()).toEqual(['ddv:init', 'ddv:step', 'ddv:init']);
  });

  it('ddv:hello の protocol が 2 でなければ版違いで失敗し、reset はその文言で失敗する', async () => {
    const x = setup('pages');
    x.t.built({});
    x.send({ type: 'ddv:hello', protocol: 3, version: 'v' });
    expect([x.t.session.state, x.t.session.failure]).toEqual(['Failed', VERSION_MISMATCH]);
    await expect(x.t.reset([])).rejects.toThrow(VERSION_MISMATCH);
    await expect(x.t.step(0, {} as never)).rejects.toThrow(VERSION_MISMATCH);
    expect(x.types()).toEqual([]);
  });

  it('Loading・Initializing は 10 秒で「モックが応答しません」', async () => {
    const x = setup('pages');
    x.t.built({});
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS - 1);
    expect(x.t.session.state).toBe('Loading');
    await vi.advanceTimersByTimeAsync(1);
    expect([x.t.session.state, x.t.session.failure]).toEqual(['Failed', NO_RESPONSE]);

    const y = setup('pages');
    y.t.built({});
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS - 1);
    y.send({ type: 'ddv:hello', protocol: 2, version: 'v' });
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS - 1);
    expect(y.t.session.state).toBe('Initializing');
    await vi.advanceTimersByTimeAsync(1);
    expect([y.t.session.state, y.t.session.failure]).toEqual(['Failed', NO_RESPONSE]);
  });

  it('Initializing の ddv:error と組み立て失敗は失敗。⟳ で組み立て中へ戻る', () => {
    const x = setup('pages');
    x.t.buildFailed('docs/mocks/a/index.html がありません');
    expect([x.t.session.state, x.t.session.failure]).toEqual(['Failed', `${BUILD_FAILED}: docs/mocks/a/index.html がありません`]);
    x.t.reload();
    expect(x.t.session.state).toBe('Building');
    x.t.built({});
    x.send({ type: 'ddv:error', message: 'early' });
    expect(x.t.session.state).toBe('Loading');
    x.send({ type: 'ddv:hello', protocol: 2, version: 'v' });
    x.send({ type: 'ddv:error', message: 'api.yaml が壊れています' });
    expect([x.t.session.state, x.t.session.failure]).toEqual(['Failed', 'api.yaml が壊れています']);
    expect(x.messages.map((m) => m.type)).toEqual(['ddv:error', 'ddv:hello', 'ddv:error']);
  });
});

describe('createFrameTransport（ローカル版）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('従来どおり: 親のオリジンへ送り、ddv:hello は無視し、3 秒待って ddv:reset を送る', async () => {
    const x = setup('local');
    expect(x.t.session.state).toBe('Loading');
    x.send({ type: 'ddv:hello', protocol: 2, version: 'v' });
    expect(x.t.session.state).toBe('Loading');
    const reset = x.t.reset(['default'], 'List');
    await vi.advanceTimersByTimeAsync(2999);
    expect(x.posted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(x.posted).toEqual([{ msg: { type: 'ddv:reset', fixtures: ['default'], start: 'List' }, origin: 'http://localhost:5173' }]);
    x.send({ type: 'ddv:ready', screen: 'List', version: 'v' }, 'null');
    x.send({ type: 'ddv:ready', screen: 'List', version: 'v' });
    await expect(reset).resolves.toEqual({ screen: 'List' });
    expect(x.t.session.state).toBe('Ready');
    // No session timeout in the local edition
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS * 2);
    expect(x.t.session.state).toBe('Ready');
    x.t.reload();
    expect(x.t.session.state).toBe('Loading');
  });

  it('protocol の無い ddv:ready（版 1）も受け付け、形式違反のメッセージは無視する', () => {
    const x = setup('local');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    x.send({ type: 'ddv:ready', screen: 1, version: 'v' });
    x.send({ type: 'ddv:future' });
    expect(x.messages).toEqual([]);
    x.send({ type: 'ddv:ready', screen: null, version: 'v' });
    expect(x.messages).toEqual([{ type: 'ddv:ready', screen: null, version: 'v' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
