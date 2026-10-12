import { parseDoc, type DiagramBlock } from '@ddv/core';
import { diffGraphs, parseMermaidGraph, type GraphDiff } from '@ddv/graph';
import { LOCK_PATH, type TestIdLock } from '@ddv/testid/core';
import type { DdvConfig } from '@ddv/core';
import type { GitHubClient } from '@ddv/github';
import type { RepoReader } from './repo-reader.ts';

export interface NameStatus {
  status: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
}

/** Changed files and unified diffs between two commits of one repository (server: `GitChangeSource`; Pages: `GitHubChangeSource`). */
export interface ChangeSource {
  nameStatus(base: string, head: string): Promise<NameStatus[]>;
  diff(base: string, head: string, paths: string[]): Promise<string>;
}

/** A change source, or one per PR context (a server-wide service serving several repositories). */
export type ChangeSourceOf = ChangeSource | ((ctx: PrContext) => ChangeSource);

export const changesFor = (src: ChangeSourceOf, ctx: PrContext): ChangeSource => (typeof src === 'function' ? src(ctx) : src);

export interface PrTarget {
  owner: string;
  repo: string;
  pr?: number;
}

/** One PR (or branch) workspace: head / merge-base readers and the commits they read. */
export interface PrContext {
  id: string;
  target: PrTarget;
  headSha: string;
  mergeBase?: string;
  head: RepoReader;
  base: RepoReader | null;
  pr?: { headRepo: string; headRef: string; canPush: boolean } | null;
}

export type Side = 'RIGHT' | 'LEFT';

interface HunkLine {
  type: ' ' | '+' | '-';
  /** line in the old file (context / removed) */
  old?: number;
  /** line in the new file (context / added); for removed lines, the new-file line that follows */
  new: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

/** Parsed `git diff --unified=3` (REVCMT Hunks). RIGHT = `+c,d` (head), LEFT = `-a,b` (merge-base). */
export class Hunks {
  /** `changed` = the diff text is not empty (a file outside the PR diff has no diff at all). */
  constructor(readonly hunks: Hunk[], readonly changed: boolean = hunks.length > 0) {}

  static parse(unifiedDiff: string): Hunks {
    const hunks: Hunk[] = [];
    let cur: Hunk | undefined;
    let o = 0;
    let n = 0;
    for (const raw of unifiedDiff.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        cur = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
        hunks.push(cur);
        o = cur.oldStart;
        n = cur.newStart;
        continue;
      }
      if (!cur) continue;
      const t = line[0];
      if (t === ' ') cur.lines.push({ type: ' ', old: o++, new: n++ });
      else if (t === '+') cur.lines.push({ type: '+', new: n++ });
      else if (t === '-') cur.lines.push({ type: '-', old: o++, new: n });
      else if (t !== '\\') cur = undefined;
    }
    return new Hunks(hunks, unifiedDiff.trim() !== '');
  }

  /** Whether start..end fits inside one hunk on the given side. */
  contains(side: Side, start: number, end: number): boolean {
    return this.hunks.some((h) => {
      const [s, len] = side === 'RIGHT' ? [h.newStart, h.newLines] : [h.oldStart, h.oldLines];
      return len > 0 && start >= s && end <= s + len - 1;
    });
  }

  /** Added lines in the new file. */
  addedLines(): Set<number> {
    const out = new Set<number>();
    for (const h of this.hunks) for (const l of h.lines) if (l.type === '+') out.add(l.new);
    return out;
  }

  /** Removed lines in the old file → the new-file line they precede. */
  removedLines(): Map<number, number> {
    const out = new Map<number, number>();
    for (const h of this.hunks) for (const l of h.lines) if (l.type === '-') out.set(l.old!, l.new);
    return out;
  }
}

export interface ChangedFile {
  status: NameStatus['status'];
  path: string;
  oldPath?: string;
}

export interface ChangedFiles {
  base?: string;
  head: string;
  docs: ChangedFile[];
  mocks: ChangedFile[];
  /** Changed files outside docs / mocks (count only). */
  others: number;
}

export type DiagramChange = 'added' | 'changed' | 'unchanged' | 'removed';

export interface DiagramDiff {
  change: DiagramChange;
  /** id of the corresponding base diagram */
  beforeId?: string;
  /** base code (changed / removed) */
  before?: string;
  diff?: GraphDiff;
}

export interface DocDiff {
  path: string;
  status: NameStatus['status'] | null;
  oldPath?: string;
  base?: string;
  head: string;
  blocks: { line: number; endLine: number; change: 'added' | 'changed' }[];
  removed: { beforeLine: number | null; markdown: string }[];
  diagrams: Record<string, DiagramDiff>;
  ids: { added: string[]; retired: string[] };
  patch: string;
}

/** Workspace fields DiffService needs. */
export type DiffTarget = Pick<PrContext, 'id' | 'target' | 'headSha' | 'mergeBase' | 'head' | 'base'>;

const under = (p: string, root: string) => {
  const r = root.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/$/, '');
  return !r || p.startsWith(`${r}/`);
};

/** REVCMT DiffService: changed files and per-document diffs between merge-base and head. */
export class DiffService {
  private cache = new Map<string, Promise<unknown>>();

  constructor(private readonly changes: ChangeSourceOf) {}

  private memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  async files(ws: DiffTarget, config: DdvConfig): Promise<ChangedFiles> {
    const empty: ChangedFiles = { base: ws.mergeBase, head: ws.headSha, docs: [], mocks: [], others: 0 };
    if (!ws.mergeBase) return empty;
    const list = await this.memo(`files:${ws.id}:${ws.mergeBase}:${ws.headSha}`, () => changesFor(this.changes, ws as PrContext).nameStatus(ws.mergeBase!, ws.headSha));
    const out = { ...empty, docs: [] as ChangedFile[], mocks: [] as ChangedFile[] };
    for (const f of list) {
      const file: ChangedFile = f.oldPath ? { status: f.status, path: f.path, oldPath: f.oldPath } : { status: f.status, path: f.path };
      if (f.path.endsWith('.md') && under(f.path, config.docsRoot) && !under(f.path, config.mocksRoot)) out.docs.push(file);
      else if (under(f.path, config.mocksRoot)) out.mocks.push(file);
      else out.others++;
    }
    return out;
  }

  async docDiff(ws: DiffTarget, config: DdvConfig, docPath: string): Promise<DocDiff> {
    const files = await this.files(ws, config);
    const file = files.docs.find((f) => f.path === docPath) ?? files.mocks.find((f) => f.path === docPath);
    const base: DocDiff = { path: docPath, status: file?.status ?? null, base: ws.mergeBase, head: ws.headSha, blocks: [], removed: [], diagrams: {}, ids: { added: [], retired: [] }, patch: '' };
    if (file?.oldPath) base.oldPath = file.oldPath;
    if (!file || !ws.mergeBase) return base;
    return this.memo(`doc:${ws.id}:${ws.mergeBase}:${ws.headSha}:${docPath}`, () => this.compute(ws, file, base));
  }

  private async compute(ws: DiffTarget, file: ChangedFile, out: DocDiff): Promise<DocDiff> {
    const mb = ws.mergeBase!;
    const oldPath = file.oldPath ?? file.path;
    const headText = file.status === 'D' ? '' : ((await ws.head.tryReadText(file.path).catch(() => null)) ?? '');
    const baseText = file.status === 'A' ? '' : ((await ws.base?.tryReadText(oldPath).catch(() => null)) ?? '');
    out.patch = await changesFor(this.changes, ws as PrContext).diff(mb, ws.headSha, file.oldPath ? [file.oldPath, file.path] : [file.path]);
    if (!file.path.endsWith('.md')) return out;

    const head = parseDoc(headText);
    const before = parseDoc(baseText);
    const hunks = Hunks.parse(out.patch);

    if (file.status === 'D') {
      if (baseText.trim()) out.removed.push({ beforeLine: null, markdown: baseText });
    } else {
      const added = hunks.addedLines();
      const all = file.status === 'A';
      for (const b of head.blocks) {
        let n = 0;
        for (let l = b.line; l <= b.endLine; l++) if (all || added.has(l)) n++;
        if (n) out.blocks.push({ line: b.line, endLine: b.endLine, change: n === b.endLine - b.line + 1 ? 'added' : 'changed' });
      }
      const removed = hunks.removedLines();
      const baseLines = baseText.split(/\r?\n/);
      for (const b of before.blocks) {
        let pos: number | undefined;
        let all = true;
        for (let l = b.line; l <= b.endLine && all; l++) {
          const p = removed.get(l);
          if (p === undefined) all = false;
          else pos ??= p;
        }
        if (!all || pos === undefined) continue;
        const next = head.blocks.find((h) => h.line >= pos!);
        out.removed.push({ beforeLine: next ? next.line : null, markdown: baseLines.slice(b.line - 1, b.endLine).join('\n') });
      }
    }

    out.diagrams = matchDiagrams(before.diagrams, head.diagrams);
    out.ids = await this.idChanges(ws, oldPath, file.path, file.status);
    return out;
  }

  private async idChanges(ws: DiffTarget, oldPath: string, newPath: string, status: ChangedFile['status']): Promise<DocDiff['ids']> {
    const parse = (s: string | null): TestIdLock | null => {
      try {
        return s ? (JSON.parse(s) as TestIdLock) : null;
      } catch {
        return null;
      }
    };
    const baseLock = parse((await ws.base?.tryReadText(LOCK_PATH).catch(() => null)) ?? null);
    const headLock = parse(await ws.head.tryReadText(LOCK_PATH).catch(() => null));
    const ids = (lock: TestIdLock | null, doc: string) => {
      const s = new Set<string>();
      if (!lock || !doc) return s;
      for (const d of Object.values(lock.diagrams ?? {})) if (d.doc === doc) for (const c of Object.values(d.cases)) if (c.status === 'active') s.add(c.id);
      return s;
    };
    const before = ids(baseLock, status === 'A' ? '' : oldPath);
    const after = ids(headLock, status === 'D' ? '' : newPath);
    return { added: [...after].filter((i) => !before.has(i)).sort(), retired: [...before].filter((i) => !after.has(i)).sort() };
  }
}

/** REVCMT DGMATCH: pairs head diagrams with base diagrams by explicit id, then id-less ones by order. */
export function matchDiagrams(base: DiagramBlock[], head: DiagramBlock[]): Record<string, DiagramDiff> {
  const hasId = (d: DiagramBlock) => typeof d.meta.id === 'string';
  const baseNoId = base.filter((d) => !hasId(d));
  const headNoId = head.filter((d) => !hasId(d));
  const used = new Set<DiagramBlock>();
  const out: Record<string, DiagramDiff> = {};
  for (const h of head) {
    const b = hasId(h) ? base.find((x) => hasId(x) && x.id === h.id) : baseNoId[headNoId.indexOf(h)];
    if (!b) {
      out[h.id] = { change: 'added' };
      continue;
    }
    used.add(b);
    const entry: DiagramDiff = { change: normalizeCode(b.code) === normalizeCode(h.code) ? 'unchanged' : 'changed', beforeId: b.id };
    if (entry.change === 'changed') {
      entry.before = b.code;
      const [g0, g1] = [safeGraph(b.code), safeGraph(h.code)];
      if (g0 && g1) entry.diff = diffGraphs(g0, g1);
    }
    out[h.id] = entry;
  }
  for (const b of base) {
    if (used.has(b)) continue;
    out[out[b.id] ? `base:${b.id}` : b.id] = { change: 'removed', beforeId: b.id, before: b.code };
  }
  return out;
}

/** Line endings (CRLF worktree vs LF blob) and trailing spaces are not changes. */
function normalizeCode(code: string): string {
  return code.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
}

function safeGraph(code: string) {
  try {
    return parseMermaidGraph(code);
  } catch {
    return null;
  }
}

interface RawPullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  previous_filename?: string;
  patch?: string;
}

/** Pages: changed files of a PR from `GET /repos/{o}/{r}/pulls/{n}/files` (all pages, memoized per head SHA). */
export class GitHubChangeSource implements ChangeSource {
  private memo = new Map<string, Promise<RawPullFile[]>>();

  constructor(
    private readonly github: Pick<GitHubClient, 'paginate'>,
    private readonly target: { owner: string; repo: string; pr: number },
  ) {}

  private list(head: string): Promise<RawPullFile[]> {
    let p = this.memo.get(head);
    if (!p) {
      const { owner, repo, pr } = this.target;
      p = this.github.paginate<RawPullFile>(`/repos/${owner}/${repo}/pulls/${pr}/files?per_page=100`);
      this.memo.set(head, p);
      p.catch(() => this.memo.delete(head));
    }
    return p;
  }

  async nameStatus(_base: string, head: string): Promise<NameStatus[]> {
    return (await this.list(head)).map((f): NameStatus => {
      if (f.status === 'renamed' || (f.status === 'copied' && f.previous_filename)) return { status: 'R', path: f.filename, oldPath: f.previous_filename ?? f.filename };
      return { status: f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : 'M', path: f.filename };
    });
  }

  /** The files' `patch` with a `diff --git` header each; a file without `patch` (omitted by GitHub) has no hunks. */
  async diff(_base: string, head: string, paths: string[]): Promise<string> {
    const want = new Set(paths);
    const out: string[] = [];
    for (const f of await this.list(head)) {
      if (!want.has(f.filename) && !(f.previous_filename && want.has(f.previous_filename))) continue;
      const a = f.previous_filename ?? f.filename;
      const header = [`diff --git a/${a} b/${f.filename}`, `--- ${f.status === 'added' ? '/dev/null' : `a/${a}`}`, `+++ ${f.status === 'removed' ? '/dev/null' : `b/${f.filename}`}`];
      out.push([...header, ...(f.patch ? [f.patch] : [])].join('\n'));
    }
    return out.length ? `${out.join('\n')}\n` : '';
  }
}