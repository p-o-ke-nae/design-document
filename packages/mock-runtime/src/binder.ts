import type { ScreenController } from './screen.ts';
import type { Validator } from './validator.ts';

export type SubmitState = 'Idle' | 'Validating' | 'Sending' | 'ShowError';
export type SubmitEvent = { type: 'click'; validate: boolean } | { type: 'check'; ok: boolean } | { type: 'response'; ok: boolean };

/** State machine of a `data-submit` button (detailed design: SUBMIT). Returns null when the event is ignored in that state. */
export function submitTransition(state: SubmitState, ev: SubmitEvent): SubmitState | null {
  switch (state) {
    case 'Idle':
    case 'ShowError':
      return ev.type === 'click' ? (ev.validate ? 'Validating' : 'Sending') : null;
    case 'Validating':
      return ev.type === 'check' ? (ev.ok ? 'Sending' : 'ShowError') : null;
    case 'Sending':
      return ev.type === 'response' ? (ev.ok ? 'Idle' : 'ShowError') : null;
  }
}

export interface BinderOptions {
  win: Window & typeof globalThis;
  root: Document | HTMLElement;
  screens: ScreenController;
  validator: Validator;
  base: () => string;
  onError?: (message: string) => void;
}

const TEMPLATE_VAR = /\{\{\s*([\w.$\u0080-\uffff]+)\s*\}\}/g;

function lookup(row: unknown, path: string): string {
  let cur: unknown = row;
  for (const p of path.split('.')) cur = cur != null && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined;
  return cur === undefined || cur === null ? '' : typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
}

/** Replaces `{{col}}` in text nodes and attribute values (never parsed as HTML). */
function substitute(node: Node, row: unknown): void {
  if (node.nodeType === 3) {
    const t = node.nodeValue ?? '';
    if (t.includes('{{')) node.nodeValue = t.replace(TEMPLATE_VAR, (_, k: string) => lookup(row, k));
    return;
  }
  if (node.nodeType === 1) {
    const el = node as Element;
    for (const a of Array.from(el.attributes)) if (a.value.includes('{{')) el.setAttribute(a.name, a.value.replace(TEMPLATE_VAR, (_, k: string) => lookup(row, k)));
  }
  for (const c of Array.from(node.childNodes)) substitute(c, row);
}

const FIELD_SKIP = new Set(['button', 'submit', 'reset', 'image', 'file']);

/** `{ key: value }` of the inputs in the scope. Key = data-testid (or `name` when it has none). */
export function collectInputs(scope: ParentNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const el of Array.from(scope.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'))) {
    const key = el.getAttribute('data-testid') ?? el.getAttribute('name');
    if (!key || el.disabled) continue;
    if (el.tagName === 'INPUT') {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();
      if (FIELD_SKIP.has(type)) continue;
      if (type === 'checkbox') {
        out[key] = input.checked;
        continue;
      }
      if ((type === 'number' || type === 'range') && input.value.trim() !== '' && Number.isFinite(Number(input.value))) {
        out[key] = Number(input.value);
        continue;
      }
    }
    out[key] = el.value;
  }
  return out;
}

/**
 * Declarative attributes: data-goto / data-submit (+ data-ok / data-ng / data-error) / data-validate / data-bind.
 * Rendered items of a `data-bind` list get the attribute `data-item` (used by `count`).
 */
export class DeclarativeBinder {
  private state = new WeakMap<Element, SubmitState>();
  private readonly errorText = new WeakMap<Element, string>();
  private readonly pending = new Set<Promise<unknown>>();
  private generation = 0;
  private abort: AbortController | null = null;

  constructor(private readonly o: BinderOptions) {}

  bind(root: Document | HTMLElement = this.o.root): void {
    if (this.abort) return;
    this.abort = new AbortController();
    root.addEventListener('click', (e) => {
      const target = e.target as Element | null;
      const el = target && typeof target.closest === 'function' ? target.closest('[data-submit], [data-goto]') : null;
      if (!el) return;
      e.preventDefault();
      this.track(this.activate(el));
    }, { signal: this.abort.signal });
  }

  unbind(): void {
    this.abort?.abort();
    this.abort = null;
  }

  /** Discards in-flight work (their results are no longer applied) and resets the submit states. */
  cancel(): void {
    this.generation++;
    this.state = new WeakMap();
  }

  submitState(el: Element): SubmitState {
    return this.state.get(el) ?? 'Idle';
  }

  /** Resolves when no declarative work (submit, goto, bind) is in flight. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    const done = () => this.pending.delete(p);
    p.then(done, done);
    return p;
  }

  /** Called after each `show`: hides error messages and re-fetches every `data-bind` in the screen. */
  onShow(screen: string): Promise<void> {
    const el = this.o.screens.element(screen);
    if (!el) return Promise.resolve();
    this.hideErrors(el);
    const binds = [...(el.hasAttribute('data-bind') ? [el] : []), ...Array.from(el.querySelectorAll<HTMLElement>('[data-bind]'))];
    return this.track(Promise.all(binds.map((b) => this.render(b))).then(() => undefined));
  }

  apiUrl(path: string): string {
    if (/^[a-z]+:\/\//i.test(path)) return path;
    const base = this.o.base();
    const prefix = base === '/' ? '' : base;
    if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) return path;
    return `${prefix}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  async render(el: HTMLElement): Promise<void> {
    const gen = this.generation;
    const path = (el.getAttribute('data-bind') ?? '').trim();
    const template = Array.from(el.children).find((c) => c.tagName === 'TEMPLATE') as HTMLTemplateElement | undefined;
    if (!path) return;
    if (!template) {
      this.o.onError?.(`data-bind="${path}" の要素に <template> がありません`);
      return;
    }
    let data: unknown = null;
    try {
      const res = await this.o.win.fetch(this.apiUrl(path), { method: 'GET' });
      if (res.ok && res.status !== 204) data = await res.json();
    } catch (e) {
      this.o.onError?.(`data-bind="${path}" の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (gen !== this.generation) return;
    for (const c of Array.from(el.children)) if (c.hasAttribute('data-item')) c.remove();
    const rows = Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
    for (const row of rows) {
      const frag = template.content.cloneNode(true) as DocumentFragment;
      substitute(frag, row);
      for (const c of Array.from(frag.children)) c.setAttribute('data-item', '');
      el.appendChild(frag);
    }
  }

  private screenOf(el: Element): HTMLElement | null {
    return el.closest<HTMLElement>('[data-screen]');
  }

  private showScreen(id: string): void {
    try {
      this.o.screens.show(id);
    } catch (e) {
      this.o.onError?.(e instanceof Error ? e.message : String(e));
    }
  }

  private async activate(el: Element): Promise<void> {
    const scope = this.screenOf(el) ?? ((this.o.root as Document).body ?? (this.o.root as HTMLElement));
    if (el.hasAttribute('data-submit')) return this.submit(el, scope);
    const goto = el.getAttribute('data-goto')!;
    if (el.hasAttribute('data-validate') && !this.o.validator.validate(scope).ok) {
      this.showErrors(scope);
      return;
    }
    this.showScreen(goto);
  }

  private async submit(el: Element, scope: HTMLElement): Promise<void> {
    const gen = this.generation;
    const validate = el.hasAttribute('data-validate') || scope.hasAttribute('data-validate');
    let s = submitTransition(this.submitState(el), { type: 'click', validate });
    if (!s) return;
    if (s === 'Validating') {
      this.state.set(el, s);
      const ok = this.o.validator.validate(scope).ok;
      s = submitTransition(s, { type: 'check', ok })!;
      if (s === 'ShowError') {
        this.state.set(el, s);
        this.showErrors(scope);
        return;
      }
    }
    this.state.set(el, 'Sending');
    this.hideErrors(scope);
    const spec = (el.getAttribute('data-submit') ?? '').trim();
    const m = /^([A-Za-z]+)\s+(\S+)$/.exec(spec);
    if (!m) {
      this.state.set(el, 'ShowError');
      this.o.onError?.(`data-submit="${spec}" の形式が正しくありません（例: "POST /orders"）`);
      return;
    }
    let ok = false;
    let message = '送信に失敗しました';
    try {
      const res = await this.o.win.fetch(this.apiUrl(m[2]), {
        method: m[1].toUpperCase(),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(collectInputs(scope)),
      });
      ok = res.ok;
      if (!ok) {
        const text = await res.text();
        try {
          const j = JSON.parse(text) as { message?: unknown };
          if (j && typeof j.message === 'string') message = j.message;
        } catch {
          if (text) message = text;
        }
      }
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    if (gen !== this.generation) {
      this.state.delete(el);
      return;
    }
    this.state.set(el, submitTransition('Sending', { type: 'response', ok })!);
    if (ok) {
      const next = el.getAttribute('data-ok');
      if (next) this.showScreen(next);
      return;
    }
    const ng = el.getAttribute('data-ng');
    if (ng) this.showScreen(ng);
    else this.showErrors(scope, message);
  }

  private errors(scope: ParentNode): HTMLElement[] {
    return Array.from(scope.querySelectorAll<HTMLElement>('[data-error]'));
  }

  private showErrors(scope: ParentNode, message?: string): void {
    for (const e of this.errors(scope)) {
      if (!this.errorText.has(e)) this.errorText.set(e, e.textContent ?? '');
      e.textContent = message ?? this.errorText.get(e) ?? '';
      e.removeAttribute('hidden');
    }
  }

  private hideErrors(scope: ParentNode): void {
    for (const e of this.errors(scope)) {
      if (this.errorText.has(e)) e.textContent = this.errorText.get(e) ?? '';
      e.setAttribute('hidden', '');
    }
  }
}
