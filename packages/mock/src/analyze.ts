import { parse, type HTMLElement } from 'node-html-parser';
import type { FieldKind } from './types.ts';

export interface FieldModel {
  key: string;
  kind: FieldKind;
  required: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  options: string[];
  sample?: string;
}

export interface ScreenModel {
  id: string;
  /** data-event → data-testid of that element ('' when it has no data-testid). */
  events: Map<string, string>;
  fields: FieldModel[];
  /** data-testid of elements that submit or validate. */
  submitters: Set<string>;
  validate: boolean;
}

export interface MockModel {
  screens: Map<string, ScreenModel>;
}

const num = (v: string | undefined) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

function fieldOf(el: HTMLElement): FieldModel | null {
  const key = el.getAttribute('data-testid');
  if (!key) return null;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  if (tag === 'input' && ['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return null;
  const kind: FieldKind = tag === 'select' ? 'select' : tag === 'input' && type === 'checkbox' ? 'checkbox' : tag === 'input' && (type === 'number' || type === 'range') ? 'number' : 'text';
  const f: FieldModel = { key, kind, required: el.hasAttribute('required'), options: [] };
  const min = num(el.getAttribute('min'));
  const max = num(el.getAttribute('max'));
  const maxLength = num(el.getAttribute('maxlength'));
  const pattern = el.getAttribute('pattern');
  if (min !== undefined) f.min = min;
  if (max !== undefined) f.max = max;
  if (maxLength !== undefined) f.maxLength = maxLength;
  if (pattern) f.pattern = pattern;
  if (kind === 'select') {
    f.options = el
      .querySelectorAll('option')
      .map((o) => o.getAttribute('value') ?? o.text.trim())
      .filter((v) => v !== '');
  }
  const sample = el.getAttribute('data-sample');
  if (sample !== undefined) f.sample = sample;
  return f;
}

export function analyzeMockHtml(html: string): MockModel {
  const root = parse(html);
  const screens = new Map<string, ScreenModel>();
  for (const el of root.querySelectorAll('[data-screen]')) {
    const id = el.getAttribute('data-screen') ?? '';
    if (!id || screens.has(id)) continue;
    const validate = el.hasAttribute('data-validate');
    const screen: ScreenModel = { id, events: new Map(), fields: [], submitters: new Set(), validate };
    for (const e of el.querySelectorAll('[data-event]')) {
      const ev = (e.getAttribute('data-event') ?? '').trim();
      const testid = e.getAttribute('data-testid') ?? '';
      if (ev && !screen.events.has(ev)) screen.events.set(ev, testid);
      if (testid && (validate || e.hasAttribute('data-submit') || e.hasAttribute('data-validate'))) screen.submitters.add(testid);
    }
    for (const e of el.querySelectorAll('[data-submit], [data-validate]')) {
      const testid = e.getAttribute('data-testid');
      if (testid && !e.hasAttribute('data-screen')) screen.submitters.add(testid);
    }
    for (const e of el.querySelectorAll('input, select, textarea')) {
      const f = fieldOf(e);
      if (f && !screen.fields.some((x) => x.key === f.key)) screen.fields.push(f);
    }
    screens.set(id, screen);
  }
  return { screens };
}
