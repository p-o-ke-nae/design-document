import { useSyncExternalStore } from 'react';
import type { PagesConfig } from '@ddv/core';
import type { RateMeter } from '../pages/target-loader.ts';
import { PatMenu } from './PatMenu.tsx';
import type { PatStore } from '../pages/pat-store.ts';

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** `edition`: 公式版 = the default `pages.config.json` (title `ddv`, no owner limit); otherwise self-hosted with its title. */
export function editionLabel(config: Pick<PagesConfig, 'title' | 'allowedOwners'>): string {
  return config.title === 'ddv' && !config.allowedOwners ? 'Pages 版（公式）' : `Pages 版（セルフホスト：${config.title}）`;
}

export function useRate(rate: RateMeter): RateMeter {
  useSyncExternalStore(
    (fn) => rate.subscribe(fn),
    () => `${rate.known}:${rate.remaining}:${rate.limit}:${rate.resetAt?.getTime() ?? 0}`,
  );
  return rate;
}

/** `rate`（header）/ `loading-rate`: `API 残り n / m`; nothing until the first response with the headers. */
export function RateText({ rate, testid, withReset }: { rate: RateMeter; testid: 'rate' | 'loading-rate'; withReset?: boolean }) {
  useRate(rate);
  if (!rate.known) return null;
  const reset = rate.resetAt ? `${hhmm(rate.resetAt)} にリセット` : '';
  return (
    <span className={rate.low ? 'rate warn' : 'rate muted'} data-testid={testid} title={reset || undefined}>
      API 残り {rate.remaining} / {rate.limit}
      {withReset && reset ? `（${reset}）` : ''}
    </span>
  );
}

/** Common header of the Pages edition (`edition`・`rate`・PAT menu); the document screen adds its navigation via `children`. */
export function PagesTopBar({ config, rate, pat, children }: { config: PagesConfig; rate: RateMeter; pat: PatStore; children?: React.ReactNode }) {
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        ddv
      </a>
      <span className="edition" data-testid="edition" title={`配信元：${location.origin}${location.pathname}`}>
        {editionLabel(config)}
      </span>
      {children}
      <span className="spacer" />
      <RateText rate={rate} testid="rate" />
      <PatMenu store={pat} />
    </header>
  );
}
