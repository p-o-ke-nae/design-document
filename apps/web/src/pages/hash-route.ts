/**
 * URL of the Pages edition (pages-viewer.md「URL」「対象の検査」, DD-PAGESV-HASH / DD-PAGESV-TARGET).
 * `#/gh/<owner>/<repo>[/pr/<N> | /ref/<ref>][/doc/<path> | /tests… | /review…][?h=<slug>&view=diff]`.
 */
import { isOwnerAllowed, type PagesConfig } from '@ddv/core';
import { isSafeRefName, repoOf, REPO_MESSAGE } from '@ddv/services';
import type { HrefView, Route } from '../route.ts';

export type TargetKind = 'pr' | 'ref';

export interface HostedTarget {
  owner: string;
  repo: string;
  kind: TargetKind;
  pr?: number;
  /** Absent = the default branch. */
  ref?: string;
}

export type TargetErrorField = 'url' | 'repo' | 'pr' | 'ref' | 'path';

/** What the user typed (or what the URL had): `repo` = `owner/repo`, `target` = PR number or branch・tag. */
export interface TargetInput {
  repo: string;
  kind: TargetKind;
  target: string;
}

export interface TargetError {
  field: TargetErrorField;
  message: string;
  input: TargetInput;
}

export interface HashParseResult {
  target: HostedTarget | null;
  route: Route;
  error?: TargetError;
}

export type ValidateResult = { target: HostedTarget; error?: undefined } | { target: null; error: TargetError };

export type HostedConfig = Pick<PagesConfig, 'defaultTarget' | 'allowedOwners'>;

export const URL_MESSAGE = 'URL を解釈できません（#/gh/owner/repo/… の形式）';
export const PR_MESSAGE = 'PR 番号を入力してください';
export const REF_MESSAGE = 'branch・tag 名を確認してください';
export const PATH_MESSAGE = '文書のパスを確認してください';
export { REPO_MESSAGE };

export const ownersMessage = (owners: readonly string[]) => `このビューアで開けるのは次の owner のリポジトリだけです：${owners.join(',')}`;

const OPEN_ROUTE: Route = { ws: '', view: 'open', path: '', heading: '' };
const PR_NUMBER = /^[1-9]\d*$/;

/** `owner/repo#pr-N` / `owner/repo@<ref>` / `owner/repo@` (default branch). The Pages `Backend` scope. */
export function targetKey(t: HostedTarget): string {
  return t.kind === 'pr' ? `${t.owner}/${t.repo}#pr-${t.pr}` : `${t.owner}/${t.repo}@${t.ref ?? ''}`;
}

/** `Route.ws` (the same form as a local workspace id; `PrProvider` / `Pr.tsx` branch on it). */
export function targetWs(t: HostedTarget): string {
  const base = `gh~${t.owner}~${t.repo}`;
  if (t.kind === 'pr') return `${base}~pr-${t.pr}`;
  return t.ref ? `${base}~ref-${t.ref.replaceAll('/', '~~')}` : `${base}~default`;
}

/** Text of the target for the screens (`loading-target`, recent items). */
export function targetLabel(t: HostedTarget): string {
  const repo = `${t.owner}/${t.repo}`;
  if (t.kind === 'pr') return `${repo} #${t.pr}`;
  return t.ref ? `${repo} ${t.ref}` : `${repo}（既定のブランチ）`;
}

export function inputOf(t: HostedTarget): TargetInput {
  return { repo: `${t.owner}/${t.repo}`, kind: t.kind, target: t.kind === 'pr' ? String(t.pr ?? '') : (t.ref ?? '') };
}

/** DD-PAGESV-TARGET: the 「開く」 form and the URL. Whitespace around the values is removed first. */
export function validateTarget(input: TargetInput, config: Pick<HostedConfig, 'allowedOwners'>): ValidateResult {
  const clean: TargetInput = { repo: input.repo.trim(), kind: input.kind, target: input.target.trim() };
  const fail = (field: TargetErrorField, message: string): ValidateResult => ({ target: null, error: { field, message, input: clean } });
  const r = repoOf(clean.repo);
  if (!r) return fail('repo', REPO_MESSAGE);
  if (config.allowedOwners && !isOwnerAllowed(r.owner, config.allowedOwners)) return fail('repo', ownersMessage(config.allowedOwners));
  if (clean.kind === 'pr') {
    if (!PR_NUMBER.test(clean.target) || !Number.isSafeInteger(Number(clean.target))) return fail('pr', PR_MESSAGE);
    return { target: { ...r, kind: 'pr', pr: Number(clean.target) } };
  }
  if (!clean.target) return { target: { ...r, kind: 'ref' } };
  if (!isSafeRefName(clean.target)) return fail('ref', REF_MESSAGE);
  return { target: { ...r, kind: 'ref', ref: clean.target } };
}

/** `PagesConfig.defaultTarget` / `recentTargets` entries as a target (null when they no longer pass `validateTarget`). */
export function targetOfConfig(t: { repo: string; pr?: number; ref?: string }, config: Pick<HostedConfig, 'allowedOwners'>): HostedTarget | null {
  return validateTarget({ repo: t.repo, kind: t.pr !== undefined ? 'pr' : 'ref', target: t.pr !== undefined ? String(t.pr) : (t.ref ?? '') }, config).target;
}

function routeOf(t: HostedTarget, rest: string[], params: URLSearchParams): Route | 'badPath' {
  const ws = targetWs(t);
  const top: Route = { ws, view: 'doc', path: '', heading: '' };
  const [head, ...tail] = rest;
  if (head === undefined) return top;
  if (head === 'doc') {
    if (!tail.length) return top;
    if (tail.some((s) => s === '' || s === '.' || s === '..')) return 'badPath';
    const route: Route = { ws, view: 'doc', path: tail.join('/'), heading: params.get('h') ?? '' };
    if (t.kind === 'pr' && params.get('view') === 'diff') route.diff = true;
    return route;
  }
  if (head === 'tests') {
    const tests: Route = { ws, view: 'tests', path: '', heading: '' };
    if (tail.length === 1 && tail[0] === 'flaky') return { ...tests, sub: 'flaky' };
    if (tail.length === 2 && tail[0] === 'history') return { ...tests, sub: 'history', testId: tail[1] };
    if (tail.length === 3 && tail[0] === 'trace') return { ...tests, sub: 'trace', runId: tail[1], testId: tail[2] };
    return tests;
  }
  if (head === 'review') {
    if (t.kind !== 'pr') return top;
    return { ws, view: tail[0] === 'done' ? 'done' : 'review', path: '', heading: '' };
  }
  return top;
}

/** DD-PAGESV-HASH. Called on start and on `hashchange`. Errors return the 「対象の指定」 route with what could be read. */
export function parseHostedHash(hash: string, config: HostedConfig): HashParseResult {
  const h = hash.replace(/^#/, '');
  const q = h.indexOf('?');
  const path = q < 0 ? h : h.slice(0, q);
  const params = new URLSearchParams(q < 0 ? '' : h.slice(q + 1));
  const fail = (field: TargetErrorField, message: string, input: TargetInput): HashParseResult => ({ target: null, route: OPEN_ROUTE, error: { field, message, input } });

  if (path === '' || path === '/') {
    const t = config.defaultTarget ? targetOfConfig(config.defaultTarget, config) : null;
    return t ? { target: t, route: { ws: targetWs(t), view: 'doc', path: '', heading: '' } } : { target: null, route: OPEN_ROUTE };
  }
  const raw = path.split('/');
  let segs: string[];
  try {
    segs = raw.map(decodeURIComponent);
  } catch {
    return fail('url', URL_MESSAGE, { repo: '', kind: 'pr', target: '' });
  }
  // ['', 'gh', owner, repo, ...]
  if (segs[0] !== '' || segs[1] !== 'gh' || !segs[2] || !segs[3]) return fail('url', URL_MESSAGE, { repo: segs[1] === 'gh' ? [segs[2], segs[3]].filter(Boolean).join('/') : '', kind: 'pr', target: '' });
  const repo = `${segs[2]}/${segs[3]}`;
  const next = segs[4];
  let input: TargetInput;
  let rest: string[];
  if (next === 'pr') {
    input = { repo, kind: 'pr', target: segs[5] ?? '' };
    if (!PR_NUMBER.test(input.target)) return fail('pr', PR_MESSAGE, input);
    rest = segs.slice(6);
  } else if (next === 'ref') {
    input = { repo, kind: 'ref', target: segs[5] ?? '' };
    if (!input.target) return fail('ref', REF_MESSAGE, input);
    rest = segs.slice(6);
  } else if (next === undefined || next === '' || next === 'doc' || next === 'tests' || next === 'review') {
    // 既定ブランチ: the rest starts at this segment (`/review` falls back to the documents for a non-PR target)
    input = { repo, kind: 'ref', target: '' };
    rest = next === '' ? [] : segs.slice(4);
  } else {
    return fail('url', URL_MESSAGE, { repo, kind: 'pr', target: '' });
  }
  const v = validateTarget(input, config);
  if (!v.target) return { target: null, route: OPEN_ROUTE, error: v.error };
  const route = routeOf(v.target, rest, params);
  if (route === 'badPath') return fail('path', PATH_MESSAGE, input);
  return { target: v.target, route };
}

const enc = encodeURIComponent;

/** The hash of a target and a view (no PAT, no commit SHA). `parseHostedHash(formatHostedHash(t, v))` gives `t` and `v` back. */
export function formatHostedHash(t: HostedTarget, view?: Partial<HrefView>): string {
  let s = `#/gh/${enc(t.owner)}/${enc(t.repo)}`;
  if (t.kind === 'pr') s += `/pr/${t.pr}`;
  else if (t.ref) s += `/ref/${enc(t.ref)}`;
  const q = new URLSearchParams();
  switch (view?.view) {
    case 'tests':
      s += '/tests';
      if (view.sub === 'flaky') s += '/flaky';
      else if (view.sub === 'history') s += `/history/${enc(view.testId ?? '')}`;
      else if (view.sub === 'trace') s += `/trace/${enc(view.runId ?? '')}/${enc(view.testId ?? '')}`;
      break;
    case 'review':
    case 'done':
      if (t.kind === 'pr') s += view.view === 'done' ? '/review/done' : '/review';
      break;
    case 'doc':
      if (view.path) {
        s += `/doc/${view.path.split('/').map(enc).join('/')}`;
        if (view.heading) q.set('h', view.heading);
        if (view.diff && t.kind === 'pr') q.set('view', 'diff');
      }
      break;
  }
  const qs = q.toString();
  return qs ? `${s}?${qs}` : s;
}
