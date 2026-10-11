import { describe, expect, it } from 'vitest';
import pngjs from 'pngjs';
import type { Browser, LaunchOptions } from '@playwright/test';
import { parseConfig } from '@ddv/core';
import { compareImages } from './image.ts';
import { browserChannel, BrowserLauncher, BrowserLaunchError, channelName } from './browser.ts';

const { PNG } = pngjs;

/** width×height white image with `dirty` black pixels at the start. */
function png(width: number, height: number, dirty = 0): Buffer {
  const p = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) p.data.set(i < dirty ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
  return PNG.sync.write(p);
}

describe('比較（DD-SNAPSHOT-CMP）', () => {
  it('[DD-SNAPSHOT-CMP-P001] [DD-SNAPSHOT-CMP-T001] [DD-SNAPSHOT-CMP-T002] 基準画像がなければ NoBase', () => {
    expect(compareImages(null, png(10, 10), 0.001)).toEqual({ status: 'NoBase' });
  });

  it('[DD-SNAPSHOT-CMP-P002] [DD-SNAPSHOT-CMP-T003] [DD-SNAPSHOT-CMP-T004] サイズが違えば Diff（ratio 1）で差分画像を返す', () => {
    const r = compareImages(png(10, 10), png(12, 10), 0.5);
    expect(r.status).toBe('Diff');
    expect(r.ratio).toBe(1);
    expect(PNG.sync.read(r.diffPng!).width).toBe(12);
  });

  it('[DD-SNAPSHOT-CMP-P003] [DD-SNAPSHOT-CMP-T005] [DD-SNAPSHOT-CMP-T006] [DD-SNAPSHOT-CMP-T007] 差分画素の割合が閾値以下なら Match', () => {
    const same = compareImages(png(100, 10), png(100, 10), 0.001);
    expect(same).toMatchObject({ status: 'Match', ratio: 0 });
    expect(same.diffPng).toBeInstanceOf(Buffer);
    const edge = compareImages(png(100, 10), png(100, 10, 1), 0.001);
    expect(edge).toMatchObject({ status: 'Match', ratio: 0.001 });
  });

  it('[DD-SNAPSHOT-CMP-P004] [DD-SNAPSHOT-CMP-T008] 閾値を超えれば Diff', () => {
    const r = compareImages(png(100, 10), png(100, 10, 2), 0.001);
    expect(r).toMatchObject({ status: 'Diff', ratio: 0.002 });
    expect(PNG.sync.read(r.diffPng!).width).toBe(100);
  });
});

describe('ブラウザの選択（DD-SNAPSHOT-CHANNEL）', () => {
  const fake = { version: () => 'x' } as unknown as Browser;
  const recorder = (fail = false) => {
    const calls: LaunchOptions[] = [];
    const launch = async (o: LaunchOptions) => {
      calls.push(o);
      if (fail) throw new Error('browserType.launch: Chromium distribution not found');
      return fake;
    };
    return { calls, launch };
  };
  const cfg = (channel?: string) => parseConfig(channel ? { mock: { browser: { channel } } } : {});

  it('[DD-SNAPSHOT-CHANNEL-P001] [DD-SNAPSHOT-CHANNEL-T001] [DD-SNAPSHOT-CHANNEL-T002] [DD-SNAPSHOT-CHANNEL-T004] [DD-SNAPSHOT-CHANNEL-T006] [DD-SNAPSHOT-CHANNEL-T011] 環境変数が chromium なら channel を指定せず同梱 Chromium', async () => {
    const r = recorder();
    const l = new BrowserLauncher(cfg('msedge'), { env: { DDV_BROWSER_CHANNEL: 'chromium' }, launch: r.launch });
    expect(l.channel()).toBe('chromium');
    expect(await l.launch()).toBe(fake);
    expect(r.calls[0].channel).toBeUndefined();
    expect(browserChannel(cfg('msedge'), { DDV_BROWSER_CHANNEL: 'chromium' })).toBeUndefined();
  });

  it('[DD-SNAPSHOT-CHANNEL-P002] [DD-SNAPSHOT-CHANNEL-T007] [DD-SNAPSHOT-CHANNEL-T008] [DD-SNAPSHOT-CHANNEL-T009] 環境変数のブラウザが起動できなければインストールを促すエラー', async () => {
    const r = recorder(true);
    const l = new BrowserLauncher(cfg(), { env: { DDV_BROWSER_CHANNEL: 'msedge' }, launch: r.launch });
    const err = await l.launch().catch((e) => e);
    expect(err).toBeInstanceOf(BrowserLaunchError);
    expect(err.message).toMatch(/ブラウザ msedge が見つからないか起動できません/);
    expect(err.message).toContain('npx playwright install');
    expect(r.calls[0].channel).toBe('msedge');
  });

  it('[DD-SNAPSHOT-CHANNEL-P003] [DD-SNAPSHOT-CHANNEL-T010] 環境変数のブラウザを channel 指定で起動', async () => {
    const r = recorder();
    const l = new BrowserLauncher(cfg(), { env: { DDV_BROWSER_CHANNEL: ' chrome ' }, launch: r.launch });
    expect(await l.launch()).toBe(fake);
    expect(r.calls[0]).toMatchObject({ channel: 'chrome', headless: true });
    expect(browserChannel(cfg(), { DDV_BROWSER_CHANNEL: 'chrome' })).toBe('chrome');
  });

  it('[DD-SNAPSHOT-CHANNEL-P004] [DD-SNAPSHOT-CHANNEL-T003] [DD-SNAPSHOT-CHANNEL-T005] 環境変数がなければ設定（既定 chromium）を使い、同梱 Chromium を実際に起動できる', async () => {
    expect(channelName(cfg(), {})).toBe('chromium');
    expect(browserChannel(cfg(), {})).toBeUndefined();
    const l = new BrowserLauncher(cfg(), { env: {} });
    const browser = await l.launch();
    try {
      expect(browser.version()).toMatch(/^\d+\./);
    } finally {
      await browser.close();
    }
  });

  it('[DD-SNAPSHOT-CHANNEL-P005] 設定のブラウザが起動できなければエラー', async () => {
    const r = recorder(true);
    const err = await new BrowserLauncher(cfg('chrome-beta'), { env: {}, launch: r.launch }).launch().catch((e) => e);
    expect(err).toBeInstanceOf(BrowserLaunchError);
    expect(err.message).toContain('npx playwright install chrome-beta');
    expect(r.calls[0].channel).toBe('chrome-beta');
  });

  it('[DD-SNAPSHOT-CHANNEL-P006] 設定のブラウザを channel 指定で起動', async () => {
    const r = recorder();
    const l = new BrowserLauncher(cfg('msedge'), { env: { DDV_BROWSER_CHANNEL: '' }, launch: r.launch });
    expect(l.channel()).toBe('msedge');
    await l.launch();
    expect(r.calls[0].channel).toBe('msedge');
    expect(browserChannel(cfg('msedge'), {})).toBe('msedge');
  });
});
