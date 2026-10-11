import type { ScreenMap } from './map.ts';

export type LocatorTarget = 'mock' | 'app';
export type LocatorKind = 'screen' | 'event' | 'field';

export type ResolvedLocator =
  | {
      ok: true;
      /** CSS selector (Playwright syntax for app maps). */
      selector?: string;
      /** URL path regular expression (app screens). */
      url?: string;
      /** Restrict the search to this container (mock events: the shown screen). */
      within?: string;
      /** The element must be visible (screen detection). */
      visible?: boolean;
    }
  | { ok: false; message: string };

export const attrSelector = (attr: string, value: string) => `[${attr}="${value.replace(/["\\]/g, '\\$&')}"]`;

/** Event name without guard (`次へ [入力OK]` → `次へ`). */
const eventName = (label: string) => label.replace(/\[[^\]]*\]/g, '').replace(/\/.*$/, '').replace(/\s+/g, ' ').trim();

/**
 * Resolves a scenario key to a locator description.
 * mock: screen = state id, event = the step's `click` value, field = data-testid.
 * app: screen = state id, event = the step's event (guard ignored), field = input/expect key; resolved via `_map.yaml`.
 */
export function resolveLocator(kind: LocatorKind, key: string, target: LocatorTarget, map?: ScreenMap, opts: { screen?: string } = {}): ResolvedLocator {
  if (target === 'mock') {
    if (kind === 'screen') return { ok: true, selector: attrSelector('data-screen', key), visible: true };
    if (kind === 'event') return { ok: true, selector: attrSelector('data-testid', key), ...(opts.screen ? { within: attrSelector('data-screen', opts.screen) } : {}) };
    return { ok: true, selector: attrSelector('data-testid', key) };
  }
  if (kind === 'screen') {
    const rule = map?.screens[key];
    if (!rule) return { ok: false, message: `対応表（_map.yaml）に画面 ${key} がありません` };
    return { ok: true, ...(rule.url !== undefined ? { url: rule.url } : {}), ...(rule.selector !== undefined ? { selector: rule.selector, visible: true } : {}) };
  }
  if (kind === 'event') {
    const name = eventName(key);
    const sel = map?.events[name];
    if (sel === undefined) return { ok: false, message: `対応表（_map.yaml）にイベント ${name} がありません` };
    return { ok: true, selector: sel };
  }
  const sel = map?.fields[key];
  return { ok: true, selector: sel ?? attrSelector('data-testid', key) };
}
