import { describe, expect, it, vi } from 'vitest';
import { acceptFrameMessage, FRAME_PROTOCOL, INIT_FILES_MAX, parseFromFrame, parseToFrame, validFiles } from './frame-protocol.ts';

const frame = { name: 'iframe' };
const expectFrame = { source: frame, origin: 'null' };
const ev = (data: unknown, over: Partial<{ source: unknown; origin: string }> = {}) => ({ source: frame, origin: 'null', data, ...over }) as unknown as MessageEvent;

describe('acceptFrameMessage', () => {
  it('[DD-MOCKSB-RECV-T001] [DD-MOCKSB-RECV-T002] [DD-MOCKSB-RECV-P001] source が期待した相手でなければ無視する', () => {
    const warn = vi.fn();
    expect(acceptFrameMessage(ev({ type: 'ddv:ready', screen: 'A', version: '1' }, { source: {} }), expectFrame, parseFromFrame, warn)).toBeNull();
    expect(acceptFrameMessage(ev({ type: 'ddv:ready', screen: 'A', version: '1' }, { source: null }), expectFrame, parseFromFrame, warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('[DD-MOCKSB-RECV-T003] [DD-MOCKSB-RECV-T004] [DD-MOCKSB-RECV-P002] origin が違えば無視する（Pages 版は null、ローカル版は location.origin）', () => {
    const warn = vi.fn();
    expect(acceptFrameMessage(ev({ type: 'ddv:ready', screen: 'A', version: '1' }, { origin: 'https://evil.example' }), expectFrame, parseFromFrame, warn)).toBeNull();
    const local = { source: frame, origin: 'http://localhost:5173' };
    expect(acceptFrameMessage(ev({ type: 'ddv:ready', screen: 'A', version: '1' }), local, parseFromFrame, warn)).toBeNull();
    expect(acceptFrameMessage(ev({ type: 'ddv:ready', screen: 'A', version: '1' }, { origin: 'http://localhost:5173' }), local, parseFromFrame, warn)).toEqual({ type: 'ddv:ready', screen: 'A', version: '1' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('[DD-MOCKSB-RECV-T005] [DD-MOCKSB-RECV-T006] [DD-MOCKSB-RECV-P003] オブジェクトでない・type が ddv: で始まらないものは無視する', () => {
    const warn = vi.fn();
    for (const data of [null, 'ddv:ready', 42, [], { type: 1 }, { type: 'ready' }, { screen: 'A' }]) {
      expect(acceptFrameMessage(ev(data), expectFrame, parseFromFrame, warn)).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('[DD-MOCKSB-RECV-T007] [DD-MOCKSB-RECV-T008] [DD-MOCKSB-RECV-P004] 受信側の知らない型は警告せずに無視する（前方互換）', () => {
    const warn = vi.fn();
    expect(acceptFrameMessage(ev({ type: 'ddv:future', x: 1 }), expectFrame, parseFromFrame, warn)).toBeNull();
    // A viewer → iframe type arriving at the viewer is unknown to it
    expect(acceptFrameMessage(ev({ type: 'ddv:reset', fixtures: [] }), expectFrame, parseFromFrame, warn)).toBeNull();
    expect(acceptFrameMessage(ev({ type: 'ddv:hello', protocol: 2, version: '1' }), expectFrame, parseToFrame, warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('[DD-MOCKSB-RECV-T009] [DD-MOCKSB-RECV-T010] [DD-MOCKSB-RECV-P005] payload が型の検査に合わなければ console.warn して無視する', () => {
    const warn = vi.fn();
    const bad: unknown[] = [
      { type: 'ddv:hello', protocol: '2', version: '1' },
      { type: 'ddv:hello', protocol: 2 },
      { type: 'ddv:ready', screen: 3, version: '1' },
      { type: 'ddv:ready', screen: 'A' },
      { type: 'ddv:result', index: -1, ok: true, failures: [] },
      { type: 'ddv:result', index: 1.5, ok: true, failures: [] },
      { type: 'ddv:result', index: 0, ok: 'yes', failures: [] },
      { type: 'ddv:result', index: 0, ok: true, failures: {} },
      { type: 'ddv:screen', screen: null },
      { type: 'ddv:error', message: { html: '<b>' } },
      { type: 'ddv:picked', path: [0, -1], tag: 'div' },
      { type: 'ddv:picked', path: [0], tag: 1 },
    ];
    for (const data of bad) expect(acceptFrameMessage(ev(data), expectFrame, parseFromFrame, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(bad.length);
    const badTo: unknown[] = [
      { type: 'ddv:init', protocol: 2, files: { 'api.yaml': 1 } },
      { type: 'ddv:init', protocol: 2, files: { '../secret.txt': 'x' } },
      { type: 'ddv:init', protocol: 2, files: { '/etc/passwd': 'x' } },
      { type: 'ddv:init', protocol: 'x', files: {} },
      { type: 'ddv:init', protocol: 2, files: { a: 'x'.repeat(INIT_FILES_MAX), b: 'y' } },
      { type: 'ddv:step', index: '0', step: {} },
      { type: 'ddv:step', index: 0, step: null },
      { type: 'ddv:tune', on: 'yes' },
      { type: 'ddv:patch', path: ['0'], patch: null },
    ];
    warn.mockClear();
    for (const data of badTo) expect(acceptFrameMessage(ev(data, { origin: 'http://localhost' }), { source: frame, origin: 'http://localhost' }, parseToFrame, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(badTo.length);
  });

  it('[DD-MOCKSB-RECV-T011] [DD-MOCKSB-RECV-P006] 検査に合えば型を整えたメッセージを返す', () => {
    const warn = vi.fn();
    const accept = (data: unknown) => acceptFrameMessage(ev(data), expectFrame, parseFromFrame, warn);
    expect(accept({ type: 'ddv:hello', protocol: FRAME_PROTOCOL, version: '0.1.0' })).toEqual({ type: 'ddv:hello', protocol: 2, version: '0.1.0' });
    expect(accept({ type: 'ddv:ready', screen: null, version: '0.1.0', protocol: 2 })).toEqual({ type: 'ddv:ready', screen: null, version: '0.1.0', protocol: 2 });
    expect(accept({ type: 'ddv:ready', screen: 'List', version: '0.1.0' })).not.toHaveProperty('protocol');
    expect(accept({ type: 'ddv:result', index: 0, ok: false, screen: 'A', failures: [], message: 'm'.repeat(5000), trace: 'not-object' })).toEqual({
      type: 'ddv:result',
      index: 0,
      ok: false,
      screen: 'A',
      failures: [],
      message: 'm'.repeat(4000),
    });
    expect(accept({ type: 'ddv:error', message: 'e'.repeat(4001) })).toEqual({ type: 'ddv:error', message: 'e'.repeat(4000) });
    expect(accept({ type: 'ddv:picked', path: [1, 0], tag: 'button', textCount: 1, attrs: {}, generated: false })).toMatchObject({ type: 'ddv:picked', path: [1, 0], tag: 'button' });
    const toFrame = (data: unknown) => acceptFrameMessage(ev(data, { source: frame, origin: 'https://o.github.io' }), { source: frame, origin: 'https://o.github.io' }, parseToFrame, warn);
    expect(toFrame({ type: 'ddv:init', protocol: 2, files: { 'api.yaml': 'base: /api', 'fixtures/default.yaml': '{}' } })).toEqual({ type: 'ddv:init', protocol: 2, files: { 'api.yaml': 'base: /api', 'fixtures/default.yaml': '{}' } });
    expect(toFrame({ type: 'ddv:reset', fixtures: ['a', 3], start: 'List', data: { a: { t: [{ id: 1 }, 2] } } })).toEqual({ type: 'ddv:reset', fixtures: ['a'], start: 'List', data: { a: { t: [{ id: 1 }] } } });
    expect(toFrame({ type: 'ddv:step', index: 2, step: { event: 'e' }, highlight: { holdMs: 99_999 }, trace: true })).toEqual({ type: 'ddv:step', index: 2, step: { event: 'e' }, highlight: { holdMs: 10_000 }, trace: true });
    expect(toFrame({ type: 'ddv:patch', path: [0, 2], patch: 'x' })).toEqual({ type: 'ddv:patch', path: [0, 2], patch: null });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('validFiles', () => {
  it('キーは .. を含まない相対パスで値は文字列', () => {
    expect(validFiles({ 'a/b.json': '{}' })).toEqual({ 'a/b.json': '{}' });
    expect(validFiles({ 'a/../b.json': '{}' })).toBeNull();
    expect(validFiles({ 'https://x/y': '' })).toBeNull();
    expect(validFiles([])).toBeNull();
  });
});
