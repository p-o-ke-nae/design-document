import type { EvidenceHost } from '@ddv/mock';
import { describe, expect, it, vi } from 'vitest';
import type { EvidenceContext } from '../index.ts';
import type { ResolvedArgs } from '../with.ts';
import { BAD_SHAPE, HooksProvider, missingArgMessage } from './hooks.ts';
import { FULLPAGE_WEB_ONLY, ScreenshotProvider, TARGET_AND_FULLPAGE } from './screenshot.ts';

function host(platform: 'web' | 'wpf' = 'web') {
  return {
    platform,
    target: 'mock',
    screenshot: vi.fn(async () => {}),
    screenshotElement: vi.fn(async (key: string) => {
      if (key !== 'submit') throw new Error(`要素 ${key} が見つかりません / 画面外です（探した名前：${key}Button・${platform}）`);
    }),
    mockTables: async () => null,
    hookContext: () => ({}),
  } as unknown as EvidenceHost & { screenshot: ReturnType<typeof vi.fn>; screenshotElement: ReturnType<typeof vi.fn> };
}
const ctx = (over: Partial<EvidenceContext> = {}) =>
  ({ platform: 'web', testId: 'T', step: 1, at: 'after', outDir: 'out', input: {}, signal: new AbortController().signal, ...over }) as EvidenceContext;
const shot = new ScreenshotProvider();

describe('スクリーンショット（SHOT）', () => {
  it('[DD-EVRUN-SHOT-P001][DD-EVRUN-SHOT-T001][DD-EVRUN-SHOT-T002][DD-EVRUN-SHOT-T003][DD-EVRUN-SHOT-T004] fullPage は Web だけ', async () => {
    const h = host('wpf');
    await expect(shot.capture({ fullPage: true }, ctx(), h)).rejects.toThrow(FULLPAGE_WEB_ONLY);
    expect(h.screenshot).not.toHaveBeenCalled();
  });

  it('[DD-EVRUN-SHOT-P002][DD-EVRUN-SHOT-T005] Web なら画面全体', async () => {
    const h = host();
    const r = await shot.capture({ fullPage: true }, ctx(), h);
    expect(h.screenshot).toHaveBeenCalledWith(expect.stringMatching(/shot\.png$/), { fullPage: true });
    expect(r.outputs).toEqual({ kind: 'image', path: h.screenshot.mock.calls[0][0] });
  });

  it('[DD-EVRUN-SHOT-P003][DD-EVRUN-SHOT-T006] fullPage が false・なしなら見えている範囲', async () => {
    for (const args of [{}, { fullPage: false }] as ResolvedArgs[]) {
      const h = host('wpf');
      await shot.capture(args, ctx(), h);
      expect(h.screenshot.mock.calls[0]).toHaveLength(1);
    }
  });

  it('[DD-EVRUN-SHOT-P004][DD-EVRUN-SHOT-T007][DD-EVRUN-SHOT-T008] target と fullPage は同時に指定できない', async () => {
    for (const fullPage of [true, false]) {
      const h = host();
      await expect(shot.capture({ target: 'submit', fullPage }, ctx(), h)).rejects.toThrow(TARGET_AND_FULLPAGE);
      expect(h.screenshotElement).not.toHaveBeenCalled();
    }
  });

  it('[DD-EVRUN-SHOT-P005][DD-EVRUN-SHOT-T009][DD-EVRUN-SHOT-T010][DD-EVRUN-SHOT-T011] 要素が無ければ失敗（探した名前・platform）', async () => {
    await expect(shot.capture({ target: 'missing' }, ctx(), host('wpf'))).rejects.toThrow('要素 missing が見つかりません / 画面外です（探した名前：missingButton・wpf）');
  });

  it('[DD-EVRUN-SHOT-P006][DD-EVRUN-SHOT-T012] 要素の範囲の PNG', async () => {
    const h = host();
    const r = await shot.capture({ target: 'submit' }, ctx(), h);
    expect(h.screenshotElement).toHaveBeenCalledWith('submit', expect.stringMatching(/shot\.png$/));
    expect(r.outputs).toMatchObject({ kind: 'image' });
  });
});

describe('hooks の関数（HOOKCALL）', () => {
  const run = vi.fn(async (args: Record<string, unknown>) => ({ kind: 'json' as const, data: args }));
  const p = new HooksProvider({ params: { id: { required: true }, n: { default: 5 } }, timeout: 3000, run });

  it('[DD-EVRUN-HOOKCALL-P001][DD-EVRUN-HOOKCALL-T001][DD-EVRUN-HOOKCALL-T002] 必須の引数が無ければ失敗', async () => {
    run.mockClear();
    await expect(p.capture({}, ctx())).rejects.toThrow(missingArgMessage('id'));
    expect(run).not.toHaveBeenCalled();
  });

  it('[DD-EVRUN-HOOKCALL-P003][DD-EVRUN-HOOKCALL-T003][DD-EVRUN-HOOKCALL-T004][DD-EVRUN-HOOKCALL-T005][DD-EVRUN-HOOKCALL-T007] default を補って呼び、出力を返す', async () => {
    const c = ctx();
    const r = await p.capture({ id: 'A1' }, c);
    expect(run).toHaveBeenLastCalledWith({ id: 'A1', n: 5 }, c);
    expect(r.outputs).toEqual({ kind: 'json', data: { id: 'A1', n: 5 } });
    expect(p.timeout).toBe(3000);
  });

  it('[DD-EVRUN-HOOKCALL-P002][DD-EVRUN-HOOKCALL-T006] 戻り値の形が不正なら失敗', async () => {
    for (const bad of [undefined, 'x', { kind: 'video' }, [{ kind: 'text', text: 1 }], { kind: 'image' }]) {
      const q = new HooksProvider({ params: {}, run: async () => bad as never });
      await expect(q.capture({}, ctx())).rejects.toThrow(BAD_SHAPE);
    }
  });
});
