import type { Browser, LaunchOptions } from '@playwright/test';
import type { DdvConfig } from '@ddv/core';

export const BUNDLED_CHANNEL = 'chromium';
export const CHANNEL_ENV = 'DDV_BROWSER_CHANNEL';

/** Browser name used for E2E and snapshots: `DDV_BROWSER_CHANNEL` first, then `mock.browser.channel` (default chromium). */
export function channelName(config: Pick<DdvConfig, 'mock'> | undefined, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[CHANNEL_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return config?.mock?.browser?.channel?.trim() || BUNDLED_CHANNEL;
}

/** Playwright `channel` option: undefined for the bundled Chromium. For `use: { channel: browserChannel(config) }`. */
export function browserChannel(config: Pick<DdvConfig, 'mock'> | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  const name = channelName(config, env);
  return name === BUNDLED_CHANNEL ? undefined : name;
}

export type LaunchFn = (opts: LaunchOptions) => Promise<Browser>;

async function defaultLaunch(opts: LaunchOptions): Promise<Browser> {
  const { chromium } = await import('@playwright/test');
  return chromium.launch(opts);
}

export class BrowserLaunchError extends Error {
  constructor(
    readonly channel: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message.split('\n')[0] : String(cause);
    const hint =
      channel === BUNDLED_CHANNEL
        ? '`npx playwright install chromium` で Playwright の Chromium をインストールしてください'
        : `ブラウザ ${channel} をインストールするか（\`npx playwright install ${channel}\`）、mock.browser.channel / ${CHANNEL_ENV} を見直してください`;
    super(`ブラウザ ${channel} が見つからないか起動できません。${hint}（${detail}）`);
    this.name = 'BrowserLaunchError';
  }
}

/** Launches the browser of `mock.browser.channel` (detailed design: ブラウザの選択). */
export class BrowserLauncher {
  constructor(
    private config: Pick<DdvConfig, 'mock'> | undefined,
    private opts: { env?: Record<string, string | undefined>; launch?: LaunchFn; headless?: boolean } = {},
  ) {}

  channel(): string {
    return channelName(this.config, this.opts.env ?? process.env);
  }

  async launch(): Promise<Browser> {
    const name = this.channel();
    const launch = this.opts.launch ?? defaultLaunch;
    const options: LaunchOptions = { headless: this.opts.headless ?? true, ...(name === BUNDLED_CHANNEL ? {} : { channel: name }) };
    try {
      return await launch(options);
    } catch (e) {
      throw new BrowserLaunchError(name, e);
    }
  }
}

export function launchBrowser(config: Pick<DdvConfig, 'mock'> | undefined, opts?: ConstructorParameters<typeof BrowserLauncher>[1]): Promise<Browser> {
  return new BrowserLauncher(config, opts).launch();
}
