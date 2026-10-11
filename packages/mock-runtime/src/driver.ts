import { StepError, type Driver, type FieldKind } from '@ddv/mock/step';
import type { DeclarativeBinder } from './binder.ts';
import type { ScreenController } from './screen.ts';

export interface DomDriverOptions {
  screens: ScreenController;
  binder: DeclarativeBinder;
  root: Document | HTMLElement;
  invoke?: (name: string) => unknown;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** 操作をハイライト: outline each element to fill / click for `holdMs` before acting. */
export interface StepHighlight {
  holdMs: number;
}

export interface ExecOptions {
  highlight?: StepHighlight | null;
}

export const HIGHLIGHT_ATTR = 'data-ddv-highlight';
/** Outline of the element under the pointer in the tune mode (same look as the step highlight). */
export const TUNE_HOVER_ATTR = 'data-ddv-tune-hover';
/** Marks elements the runtime adds to the page (not counted in element paths). */
export const DDV_UI_ATTR = 'data-ddv-ui';
const HIGHLIGHT_STYLE_ID = 'ddv-highlight-style';
const HIGHLIGHT_CSS = `[${HIGHLIGHT_ATTR}],[${TUNE_HOVER_ATTR}]{outline:3px solid #f59e0b !important;outline-offset:2px;box-shadow:0 0 0 6px rgba(245,158,11,.25) !important;transition:outline-color .1s}`;

export function ensureHighlightStyle(doc: Document): void {
  if (doc.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = HIGHLIGHT_STYLE_ID;
  s.setAttribute(DDV_UI_ATTR, '');
  s.textContent = HIGHLIGHT_CSS;
  (doc.head ?? doc.documentElement).appendChild(s);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const esc = (s: string) => s.replace(/["\\]/g, '\\$&');

/**
 * `Driver` over the live DOM. Keys are `data-testid`, looked up in the visible screen first.
 * `count(key)` = number of items rendered from the `<template>` of that element (`[data-item]` children, see DeclarativeBinder).
 */
export class DomDriver implements Driver {
  /** Set by MockRuntime.exec for one step; null = no highlight. */
  highlight: StepHighlight | null = null;

  constructor(private readonly o: DomDriverOptions) {}

  /** Outlines the element, waits holdMs, runs the action, then removes the outline. */
  private async withHighlight<T>(el: HTMLElement, act: () => T | Promise<T>): Promise<T> {
    const h = this.highlight;
    if (!h) return act();
    ensureHighlightStyle(el.ownerDocument);
    el.setAttribute(HIGHLIGHT_ATTR, '');
    try {
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      if (h.holdMs > 0) await (this.o.sleep ?? defaultSleep)(h.holdMs);
      return await act();
    } finally {
      el.removeAttribute(HIGHLIGHT_ATTR);
    }
  }


  find(key: string): HTMLElement | null {
    const sel = `[data-testid="${esc(key)}"]`;
    const screen = this.o.screens.element();
    return screen?.querySelector<HTMLElement>(sel) ?? (screen?.matches(sel) ? screen : null) ?? this.visibleOutsideScreens(sel);
  }

  private visibleOutsideScreens(sel: string): HTMLElement | null {
    for (const el of Array.from(this.o.root.querySelectorAll<HTMLElement>(sel))) if (!el.closest('[data-screen]')) return el;
    return null;
  }

  fieldKind(key: string): FieldKind | null {
    const el = this.find(key);
    if (!el) return null;
    const tag = el.tagName;
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'text';
    if (tag !== 'INPUT') return el.isContentEditable ? 'text' : null;
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'number' || type === 'range') return 'number';
    return 'text';
  }

  async fill(key: string, value: string | boolean): Promise<void> {
    const el = this.find(key) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) throw new StepError('notFound', `入力要素が見つかりません: ${key}`, { key });
    await this.withHighlight(el, () => this.applyFill(el, key, value));
  }

  private applyFill(el: HTMLInputElement | HTMLSelectElement, key: string, value: string | boolean): void {
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox') (el as HTMLInputElement).checked = value === true || value === 'true';
    else if (el.tagName === 'SELECT') {
      const opts = Array.from((el as HTMLSelectElement).options);
      const v = String(value);
      const opt = opts.find((o) => o.value === v) ?? opts.find((o) => (o.textContent ?? '').trim() === v);
      if (!opt) throw new StepError('notFound', `選択肢がありません: ${key} = ${v}`, { key });
      (el as HTMLSelectElement).value = opt.value;
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = String(value);
    else el.textContent = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async click(key: string): Promise<void> {
    const el = this.find(key);
    if (!el) throw new StepError('notFound', `クリックする要素が見つかりません: ${key}`, { key });
    await this.withHighlight(el, () => el.click());
    await this.o.binder.settled();
  }

  async invoke(name: string): Promise<void> {
    await this.o.invoke?.(name);
    await this.o.binder.settled();
  }

  screen(): string | null {
    return this.o.screens.current;
  }

  isVisible(key: string): boolean {
    const el = this.find(key);
    if (!el) return false;
    for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
      if (cur.hidden || cur.hasAttribute('hidden')) return false;
      const style = cur.ownerDocument.defaultView?.getComputedStyle(cur);
      if (cur.style.display === 'none' || style?.display === 'none' || cur.style.visibility === 'hidden') return false;
    }
    return true;
  }

  text(key: string): string | null {
    const el = this.find(key);
    if (!el) return null;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return (el as HTMLInputElement).value;
    return el.textContent;
  }

  count(key: string): number {
    const el = this.find(key);
    if (!el) return 0;
    return Array.from(el.children).filter((c) => c.hasAttribute('data-item')).length;
  }
}
