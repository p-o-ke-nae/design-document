import { elementsOf, normalizePath, parseDoc, toAnchor, type ElementKind, type ElementRef } from '@ddv/core';
import type { GitHubClient } from '@ddv/github';
import { LOCK_PATH, parseLock } from '@ddv/testid/core';
import { BODY_MAX, COMMENT_MAX, ReviewError } from './errors.ts';
import { changesFor, Hunks, type ChangeSourceOf, type PrContext, type Side } from './pr-diff.ts';
import type { PullInfo } from './pr.ts';
import { setStatus, type StatusCommitter } from './status-commit.ts';

export type CommentState = 'Pending' | 'Drifted';
export type Placement = 'line' | 'file' | 'body';
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface Anchor {
  path: string;
  side: Side;
  startLine: number;
  line: number;
  /** Content of startLine..line (used to re-attach after the head moves). */
  lineText: string[];
  element: ElementRef;
}

export interface PendingComment {
  id: string;
  anchor: Anchor;
  body: string;
  suggestion?: string;
  state: CommentState;
  placement: Placement;
  /** placement = line but only `anchor.line` fits a hunk: posted as a single-line comment (REVCMT PLACE). */
  shrunk?: boolean;
  commitId: string;
  /** Why the comment is Drifted. */
  reason?: string;
}

export interface PendingReview {
  headSha: string;
  mergeBase?: string;
  comments: PendingComment[];
}

export interface SubmitResult {
  reviewId: number;
  reviewUrl: string;
  posted: { line: number; file: number; body: number };
  failed: { id: string; message: string }[];
  statusCommit?: { mode: 'commit'; sha: string; paths: string[] } | { mode: 'suggestion'; paths: string[] };
  warnings?: string[];
}

/** Where the pending review of a PR is kept (server: `FsPendingStore` = `DDV_HOME/reviews/<owner>/<repo>/pr-<N>.json`). */
export interface PendingReviewStore {
  read(owner: string, repo: string, pr: number): Promise<PendingReview>;
  write(owner: string, repo: string, pr: number, review: PendingReview): Promise<void>;
}

/** The part of a workspace ReviewService needs. */
export type ReviewTarget = Pick<PrContext, 'id' | 'target' | 'headSha' | 'mergeBase' | 'head' | 'base'> & {
  pr?: Pick<PullInfo, 'headRepo' | 'headRef' | 'canPush'> | null;
};

export interface ReviewServiceOptions {
  store: PendingReviewStore;
  github: GitHubClient;
  changes: ChangeSourceOf;
  committer: StatusCommitter;
  /** Re-fetches the workspace (new head); resolves when it is Ready again. */
  refresh: (wsId: string) => Promise<void>;
  /** PR information when the workspace has none yet (after a restore). */
  pull?: (wsId: string) => Promise<PullInfo | undefined>;
  /** Called after the pending review or GitHub threads changed (cache invalidation). */
  onChange?: (wsId: string) => void;
  /** Comment ids (default `crypto.randomUUID`). */
  newId?: () => string;
}

/** REVCMT PLACE: line comment inside a hunk, a file comment, or (file outside the PR diff, which GitHub cannot attach to) part of the review body. */
export function judgePlacement(hunks: Hunks | null, a: Pick<Anchor, 'side' | 'startLine' | 'line'>, hasSuggestion: boolean): { placement: Placement; shrunk: boolean } {
  if (hunks && !hunks.changed) return { placement: 'body', shrunk: false };
  if (!hunks || !hunks.hunks.length) return { placement: 'file', shrunk: false };
  if (hunks.contains(a.side, a.startLine, a.line)) return { placement: 'line', shrunk: false };
  if (!hasSuggestion && hunks.contains(a.side, a.line, a.line)) return { placement: 'line', shrunk: true };
  return { placement: 'file', shrunk: false };
}

const KINDS: ElementKind[] = ['block', 'tableRow', 'node', 'edge', 'diagram', 'matrixRow', 'mockElement', 'testData'];
const EVENTS: ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fileLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function fence(content: string, info = ''): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((s) => s.length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}${info}\n${content}\n${f}`;
}

function quoteLines(a: Anchor): string {
  const range = a.startLine === a.line ? `L${a.line}` : `L${a.startLine}-${a.line}`;
  return a.lineText.map((t, i) => (i === 0 ? `> ${range}: ${t}` : `> ${t}`)).join('\n');
}

/** Body as posted to GitHub (quote of the line for file comments, test ID for matrix rows, suggestion block). */
export function composeBody(c: PendingComment): string {
  const parts: string[] = [];
  if (c.anchor.element.kind === 'matrixRow') parts.push(`> ${c.anchor.element.key}: ${c.anchor.element.label}`);
  if (c.placement !== 'line') parts.push(quoteLines(c.anchor));
  parts.push(c.body);
  if (c.suggestion !== undefined && c.suggestion !== '') {
    parts.push(c.placement === 'line' && !c.shrunk ? fence(c.suggestion, 'suggestion') : `提案する変更:\n\n${fence(c.suggestion)}`);
  }
  return parts.join('\n\n');
}

/** Review body: the reviewer's text followed by the comments GitHub cannot attach to a file (outside the PR diff). */
export function composeReviewBody(body: string, comments: PendingComment[]): string {
  const parts = body.trim() ? [body] : [];
  for (const c of comments) parts.push(`**\`${c.anchor.path}\`**\n\n${composeBody(c)}`);
  return parts.join('\n\n---\n\n');
}

function checkBody(body: unknown): string {
  if (typeof body !== 'string' || !body.trim()) throw new ReviewError(422, 'comment-required', 'コメントを入力してください');
  if (body.length > COMMENT_MAX) throw new ReviewError(422, 'comment-too-long', `コメントは ${COMMENT_MAX} 文字以内で入力してください`);
  return body;
}

function parseSuggestion(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ReviewError(422, 'suggestion-invalid', 'suggestion は文字列で指定してください');
  return v;
}

export interface CommentInput {
  /** A ready Anchor, or `{ path, element, side? }` (lines are computed), or `{ path, side?, startLine, line }`. */
  anchor?: unknown;
  path?: unknown;
  element?: unknown;
  side?: unknown;
  body?: unknown;
  /** Replacement lines; empty / null = none. Only for RIGHT. */
  suggestion?: unknown;
}

/** REVCMT ReviewService: pending review per PR (add / update / remove / relocate / submit). */
export class ReviewService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: ReviewServiceOptions) {}

  private newId(): string {
    return this.opts.newId ? this.opts.newId() : crypto.randomUUID();
  }

  private serial<T>(wsId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(wsId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(wsId, tail);
    void tail.then(() => this.locks.get(wsId) === tail && this.locks.delete(wsId));
    return run;
  }

  private prOf(ws: ReviewTarget): number {
    if (!ws.target.pr) throw new ReviewError(409, 'not-pr', 'PR のワークスペースでのみレビューできます');
    return ws.target.pr;
  }

  private async load(ws: ReviewTarget): Promise<PendingReview> {
    const { owner, repo } = ws.target;
    const review = await this.opts.store.read(owner, repo, this.prOf(ws));
    if (review.headSha && review.headSha !== ws.headSha && review.comments.length) await this.relocateIn(ws, review);
    review.headSha = ws.headSha;
    if (ws.mergeBase) review.mergeBase = ws.mergeBase;
    return review;
  }

  private save(ws: ReviewTarget, review: PendingReview): Promise<void> {
    return this.opts.store.write(ws.target.owner, ws.target.repo, this.prOf(ws), review);
  }

  private async mutate<T>(ws: ReviewTarget, fn: (review: PendingReview) => Promise<T> | T): Promise<T> {
    return this.serial(ws.id, async () => {
      const review = await this.load(ws);
      const out = await fn(review);
      await this.save(ws, review);
      return out;
    });
  }

  async get(ws: ReviewTarget): Promise<PendingReview> {
    return this.mutate(ws, (r) => r);
  }

  private async hunksOf(ws: ReviewTarget, file: string, cache = new Map<string, Hunks | null>()): Promise<Hunks | null> {
    if (cache.has(file)) return cache.get(file)!;
    let hunks: Hunks | null = null;
    if (ws.mergeBase) hunks = Hunks.parse(await changesFor(this.opts.changes, ws as PrContext).diff(ws.mergeBase, ws.headSha, [file]).catch(() => ''));
    cache.set(file, hunks);
    return hunks;
  }

  private async textOf(ws: ReviewTarget, file: string, side: Side, mergeBase = ws.mergeBase): Promise<string | null> {
    if (side === 'LEFT') return mergeBase && ws.base ? ws.base.tryReadText(file).catch(() => null) : null;
    return ws.head.tryReadText(file).catch(() => null);
  }

  /** REVCMT ANCHOR: element (or lines) → Anchor with `lineText` read from the file. */
  async toAnchor(ws: ReviewTarget, input: unknown): Promise<Anchor> {
    if (!isObj(input)) throw new ReviewError(422, 'anchor-invalid', '場所（anchor）を指定してください');
    const file = typeof input.path === 'string' ? normalizePath(input.path) : '';
    if (!file) throw new ReviewError(422, 'anchor-invalid', 'anchor.path が必要です');
    const side: Side = input.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    const el = isObj(input.element) ? input.element : undefined;
    if (el && (!KINDS.includes(el.kind as ElementKind) || typeof el.key !== 'string' || !el.key)) throw new ReviewError(422, 'anchor-invalid', 'anchor.element は { kind, key, label } で指定してください');
    let text: string | null;
    try {
      text = await this.textOf(ws, file, side);
    } catch {
      text = null;
    }
    if (text === null) throw new ReviewError(422, 'anchor-not-found', `ファイルが見つかりません: ${file}`);

    let startLine: number | undefined;
    let line: number | undefined;
    let label = typeof el?.label === 'string' && el.label ? el.label : undefined;
    if (isInt(input.line) || isInt(input.startLine)) {
      line = isInt(input.line) ? input.line : (input.startLine as number);
      startLine = isInt(input.startLine) ? input.startLine : line;
    } else if (el) {
      if (side === 'LEFT' || el.kind === 'mockElement' || el.kind === 'testData') throw new ReviewError(422, 'anchor-invalid', 'この要素は行番号（startLine / line）で指定してください');
      const doc = parseDoc(text);
      const elements = elementsOf(doc, text);
      const lock = await ws.head
        .tryReadText(LOCK_PATH)
        .then(parseLock)
        .catch(() => null);
      const diagramOf = (id: string) => Object.values(lock?.diagrams ?? {}).find((d) => Object.values(d.cases).some((c) => c.id === id))?.diagram;
      const ref: ElementRef = { kind: el.kind as ElementKind, key: el.key as string, label: label ?? (el.key as string) };
      const r = toAnchor(doc, ref, { elements, diagramOf });
      if (!r) throw new ReviewError(422, 'anchor-not-found', `要素が見つかりません: ${ref.key}`);
      ({ startLine, line } = r);
      label ??= elements.find((e) => e.kind === ref.kind && e.key === ref.key)?.label;
    } else {
      throw new ReviewError(422, 'anchor-invalid', 'anchor には element か行番号（line）が必要です');
    }
    const lines = fileLines(text);
    if (startLine! > line! || line! > lines.length) throw new ReviewError(422, 'anchor-invalid', `行番号がファイルの範囲外です（${file}: 1〜${lines.length}）`);
    const lineText = lines.slice(startLine! - 1, line!);
    const element: ElementRef = el
      ? { kind: el.kind as ElementKind, key: el.key as string, label: label ?? (el.key as string) }
      : { kind: 'block', key: `L${startLine}`, label: lineText[0].trim().slice(0, 60) || `L${startLine}` };
    return { path: file, side, startLine: startLine!, line: line!, lineText, element };
  }

  private anchorInput(input: CommentInput): unknown {
    return input.anchor ?? { path: input.path, element: input.element, side: input.side };
  }

  async add(ws: ReviewTarget, input: CommentInput): Promise<PendingComment> {
    return this.mutate(ws, async (review) => {
      const body = checkBody(input.body);
      const suggestion = parseSuggestion(input.suggestion);
      const anchor = await this.toAnchor(ws, this.anchorInput(input));
      if (suggestion !== undefined && anchor.side === 'LEFT') throw new ReviewError(422, 'suggestion-invalid', 'suggestion は head 側の行にだけ付けられます');
      const comment: PendingComment = { id: this.newId(), anchor, body, ...(suggestion !== undefined ? { suggestion } : {}), state: 'Pending', placement: 'file', commitId: ws.headSha };
      await this.place(ws, comment);
      review.comments.push(comment);
      return comment;
    });
  }

  private async place(ws: ReviewTarget, c: PendingComment, cache?: Map<string, Hunks | null>): Promise<void> {
    const r = judgePlacement(await this.hunksOf(ws, c.anchor.path, cache), c.anchor, c.suggestion !== undefined);
    c.placement = r.placement;
    if (r.shrunk) c.shrunk = true;
    else delete c.shrunk;
  }

  async update(ws: ReviewTarget, id: string, patch: CommentInput): Promise<PendingComment> {
    return this.mutate(ws, async (review) => {
      const c = review.comments.find((x) => x.id === id);
      if (!c) throw new ReviewError(404, 'not-found', 'コメントが見つかりません');
      const next: PendingComment = { ...c };
      if (patch.body !== undefined) next.body = checkBody(patch.body);
      if (patch.suggestion !== undefined) {
        const s = parseSuggestion(patch.suggestion);
        if (s === undefined) delete next.suggestion;
        else next.suggestion = s;
      }
      const moves = patch.anchor !== undefined || patch.element !== undefined || patch.path !== undefined;
      if (moves) {
        next.anchor = await this.toAnchor(ws, this.anchorInput(patch));
        next.state = 'Pending';
        next.commitId = ws.headSha;
        delete next.reason;
      }
      if (next.suggestion !== undefined && next.anchor.side === 'LEFT') throw new ReviewError(422, 'suggestion-invalid', 'suggestion は head 側の行にだけ付けられます');
      await this.place(ws, next);
      review.comments[review.comments.indexOf(c)] = next;
      return next;
    });
  }

  async remove(ws: ReviewTarget, id: string): Promise<void> {
    await this.mutate(ws, (review) => {
      const i = review.comments.findIndex((x) => x.id === id);
      if (i < 0) throw new ReviewError(404, 'not-found', 'コメントが見つかりません');
      review.comments.splice(i, 1);
    });
  }

  /** REVCMT RELOC: re-attaches Pending comments to the new head by their line content. */
  async relocate(ws: ReviewTarget, newHead?: string): Promise<PendingReview> {
    const target = newHead && newHead !== ws.headSha ? { ...ws, headSha: newHead } : ws;
    return this.serial(ws.id, async () => {
      const review = await this.opts.store.read(ws.target.owner, ws.target.repo, this.prOf(ws));
      if (!review.comments.length) return review;
      await this.relocateIn(target, review);
      await this.save(ws, review);
      this.opts.onChange?.(ws.id);
      return review;
    });
  }

  private async relocateIn(ws: ReviewTarget, review: PendingReview): Promise<void> {
    const oldMergeBase = review.mergeBase;
    const cache = new Map<string, Hunks | null>();
    for (const c of review.comments) {
      if (c.state !== 'Pending') continue;
      const a = c.anchor;
      const sameBase = a.side === 'LEFT' && (oldMergeBase ?? '') === (ws.mergeBase ?? '');
      if (!sameBase) {
        const text = await this.textOf(ws, a.path, a.side);
        if (text === null) {
          c.state = 'Drifted';
          c.reason = 'ファイルが削除された';
          continue;
        }
        const lines = fileLines(text);
        const n = a.lineText.length;
        const same = (i: number) => i >= 0 && i + n <= lines.length && a.lineText.every((t, k) => lines[i + k] === t);
        if (!same(a.startLine - 1)) {
          const hits: number[] = [];
          for (let i = 0; i + n <= lines.length; i++) if (same(i)) hits.push(i);
          if (!hits.length) {
            c.state = 'Drifted';
            c.reason = '内容が変わった';
            continue;
          }
          const best = hits.reduce((p, h) => (Math.abs(h + 1 - a.startLine) < Math.abs(p + 1 - a.startLine) ? h : p));
          a.startLine = best + 1;
          a.line = best + n;
        }
      }
      c.commitId = ws.headSha;
      await this.place(ws, c, cache);
    }
    review.headSha = ws.headSha;
    if (ws.mergeBase) review.mergeBase = ws.mergeBase;
  }

  /** REVCMT submit (POST / APPROVE): validate → optional status commit → create the review → file comments one by one. */
  async submit(ws: ReviewTarget, event: unknown, body: unknown = '', approveDocs: unknown = []): Promise<SubmitResult> {
    const result = await this.serial(ws.id, () => this.submitLocked(ws, event, body, approveDocs));
    this.opts.onChange?.(ws.id);
    return result;
  }

  private async submitLocked(ws: ReviewTarget, rawEvent: unknown, rawBody: unknown, rawDocs: unknown): Promise<SubmitResult> {
    const pr = this.prOf(ws);
    const { owner, repo } = ws.target;
    const event = rawEvent as ReviewEvent;
    if (!EVENTS.includes(event)) throw new ReviewError(422, 'invalid-event', 'event は COMMENT / APPROVE / REQUEST_CHANGES のいずれかです');
    const body = typeof rawBody === 'string' ? rawBody : '';
    if (body.length > BODY_MAX) throw new ReviewError(422, 'body-too-long', `本文は ${BODY_MAX} 文字以内で入力してください`);
    const docs = Array.isArray(rawDocs) ? rawDocs.filter((d): d is string => typeof d === 'string').map(normalizePath) : [];

    const review = await this.load(ws);
    if (review.comments.some((c) => c.state === 'Drifted')) throw new ReviewError(422, 'drifted', '位置を確認していないコメントがあります');
    if (event !== 'APPROVE' && !body.trim() && !review.comments.some((c) => c.placement !== 'file')) {
      throw new ReviewError(422, 'body-required', 'Comment / Request changes には本文が必要です');
    }

    const result: SubmitResult = { reviewId: 0, reviewUrl: '', posted: { line: 0, file: 0, body: 0 }, failed: [] };
    if (event === 'APPROVE' && docs.length) await this.approveStatus(ws, review, docs, result);

    const lineComments = review.comments.filter((c) => c.placement === 'line');
    const bodyComments = review.comments.filter((c) => c.placement === 'body');
    const reviewBody = composeReviewBody(body, bodyComments);
    const created = await this.opts.github.rest<{ id: number; html_url: string }>('POST', `/repos/${owner}/${repo}/pulls/${pr}/reviews`, {
      commit_id: ws.headSha,
      event,
      ...(reviewBody ? { body: reviewBody } : {}),
      comments: lineComments.map((c) => ({
        path: c.anchor.path,
        body: composeBody(c),
        line: c.anchor.line,
        side: c.anchor.side,
        ...(!c.shrunk && c.anchor.startLine < c.anchor.line ? { start_line: c.anchor.startLine, start_side: c.anchor.side } : {}),
      })),
    });
    result.reviewId = created.id;
    result.reviewUrl = created.html_url;
    result.posted.line = lineComments.length;
    result.posted.body = bodyComments.length;
    review.comments = review.comments.filter((c) => c.placement === 'file');
    await this.save(ws, review);

    const files = [...review.comments];
    for (let i = 0; i < files.length; i++) {
      const c = files[i];
      try {
        await this.opts.github.rest('POST', `/repos/${owner}/${repo}/pulls/${pr}/comments`, { commit_id: ws.headSha, path: c.anchor.path, body: composeBody(c), subject_type: 'file' });
      } catch (e) {
        const message = (e as Error).message;
        result.failed.push({ id: c.id, message });
        for (const rest of files.slice(i + 1)) result.failed.push({ id: rest.id, message: '前のコメントの投稿に失敗したため送信していません' });
        break;
      }
      result.posted.file++;
      review.comments = review.comments.filter((x) => x.id !== c.id);
      await this.save(ws, review);
    }
    return result;
  }

  /** APPROVE 連動: commit `status: approved` to the head branch, or leave suggestion comments when it cannot be written. */
  private async approveStatus(ws: ReviewTarget, review: PendingReview, docs: string[], result: SubmitResult): Promise<void> {
    const needed: { path: string; text: string }[] = [];
    for (const p of docs) {
      const text = await this.textOf(ws, p, 'RIGHT');
      if (text === null) {
        (result.warnings ??= []).push(`${p}: ファイルが見つかりません`);
        continue;
      }
      const edit = setStatus(text);
      if (edit.warning) (result.warnings ??= []).push(`${p}: ${edit.warning}`);
      if (edit.changed) needed.push({ path: p, text });
    }
    if (!needed.length) return;
    const pr = ws.pr ?? (await this.opts.pull?.(ws.id));
    const target = { ...ws, pr };
    if (pr?.canPush) {
      const commit = await this.opts.committer.commit({ headSha: ws.headSha, head: ws.head, pr }, needed.map((n) => n.path));
      if (!commit) return;
      await this.opts.refresh(ws.id);
      await this.relocateIn(ws, review);
      await this.save(ws, review);
      result.statusCommit = { mode: 'commit', sha: commit.sha, paths: commit.paths };
      return;
    }
    const cache = new Map<string, Hunks | null>();
    for (const n of needed) {
      const edit = setStatus(n.text);
      const exists = review.comments.some((c) => c.anchor.path === n.path && c.anchor.element.key === 'status' && c.state === 'Pending');
      if (exists || edit.line === undefined) continue;
      const lines = fileLines(n.text);
      const comment: PendingComment = {
        id: this.newId(),
        anchor: { path: n.path, side: 'RIGHT', startLine: edit.line, line: edit.line, lineText: [lines[edit.line - 1] ?? ''], element: { kind: 'block', key: 'status', label: 'status' } },
        body: 'status を approved にします（ddv の Approve 連動）',
        suggestion: edit.suggestion,
        state: 'Pending',
        placement: 'file',
        commitId: ws.headSha,
      };
      await this.place(target, comment, cache);
      review.comments.push(comment);
    }
    await this.save(ws, review);
    result.statusCommit = { mode: 'suggestion', paths: needed.map((n) => n.path) };
  }
}
