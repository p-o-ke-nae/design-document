import { elementAt, elementsOf, parseDoc, type DocElement } from '@ddv/core';
import type { GitHubClient } from '@ddv/github';
import { COMMENT_MAX, ReviewError } from './errors.ts';
import type { PrContext } from './pr-diff.ts';

export interface ThreadComment {
  /** REST databaseId (used for replies) */
  id: number;
  nodeId: string;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export type ThreadPlacement =
  | { kind: 'element'; element: DocElement }
  /** File-level comment, or a line not inside any element: shown at the top of the document. */
  | { kind: 'file' }
  /** The commented line no longer exists in head (or is on the base side): shown at the top. */
  | { kind: 'outdated' };

export interface Thread {
  id: string;
  url: string;
  resolved: boolean;
  outdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  side: 'LEFT' | 'RIGHT';
  comments: ThreadComment[];
  placement?: ThreadPlacement;
}

export type ThreadTarget = Pick<PrContext, 'id' | 'target' | 'headSha' | 'head'>;

const QUERY = `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine diffSide
          comments(first: 50) { nodes { id databaseId author { login } body createdAt url } }
        }
      }
    }
  }
}`;

interface RawThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide?: 'LEFT' | 'RIGHT' | null;
  comments: { nodes: { id: string; databaseId: number; author: { login: string } | null; body: string; createdAt: string; url: string }[] };
}

interface RawPage {
  repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawThread[] } } | null } | null;
}

export const THREAD_CACHE_MS = 30_000;

/**
 * REVCMT THREAD: where to show a thread in the displayed document.
 * Returns undefined when the thread is for another file (対象外).
 */
export function anchorThread(t: Pick<Thread, 'path' | 'line' | 'outdated' | 'side'>, docPath: string, elements: DocElement[]): ThreadPlacement | undefined {
  if (t.path !== docPath) return undefined;
  if (t.line == null) return { kind: 'file' };
  if (t.outdated || t.side === 'LEFT') return { kind: 'outdated' };
  const el = elementAt(elements, t.line);
  return el ? { kind: 'element', element: el } : { kind: 'file' };
}

/** REVCMT ThreadService (read side): review threads via GraphQL, cached per workspace head for 30 s. */
export class ThreadService {
  private cache = new Map<string, { at: number; threads: Promise<Thread[]> }>();

  constructor(
    private readonly github: GitHubClient,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Drops the cache of a workspace (after reply / resolve / submit). */
  invalidate(wsId: string): void {
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${wsId}@`)) this.cache.delete(k);
  }

  private fetchAll(ws: ThreadTarget): Promise<Thread[]> {
    const key = `${ws.id}@${ws.headSha}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < THREAD_CACHE_MS) return hit.threads;
    const threads = this.load(ws);
    this.cache.set(key, { at: this.now(), threads });
    threads.catch(() => this.cache.delete(key));
    return threads;
  }

  private async load(ws: ThreadTarget): Promise<Thread[]> {
    if (!ws.target.pr) return [];
    const out: Thread[] = [];
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      const data: RawPage = await this.github.graphql<RawPage>(QUERY, { owner: ws.target.owner, repo: ws.target.repo, pr: ws.target.pr, after });
      const page = data.repository?.pullRequest?.reviewThreads;
      if (!page) break;
      for (const t of page.nodes) {
        const comments = t.comments.nodes.map((c) => ({ id: c.databaseId, nodeId: c.id, author: c.author?.login ?? 'ghost', body: c.body, createdAt: c.createdAt, url: c.url }));
        out.push({
          id: t.id,
          url: comments[0]?.url ?? '',
          resolved: t.isResolved,
          outdated: t.isOutdated,
          path: t.path,
          line: t.line ?? null,
          startLine: t.startLine ?? null,
          side: t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
          comments,
        });
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    // Unresolved first; keep GitHub's order otherwise.
    return out.map((t, i) => ({ t, i })).sort((a, b) => Number(a.t.resolved) - Number(b.t.resolved) || a.i - b.i).map(({ t }) => t);
  }

  private async find(ws: ThreadTarget, threadId: string): Promise<Thread> {
    let t = (await this.fetchAll(ws)).find((x) => x.id === threadId);
    if (!t) {
      this.invalidate(ws.id);
      t = (await this.fetchAll(ws)).find((x) => x.id === threadId);
    }
    if (!t) throw new ReviewError(404, 'not-found', 'スレッドが見つかりません');
    return t;
  }

  /** Reply to a thread right away (REST `.../comments/{first comment id}/replies`). */
  async reply(ws: ThreadTarget, threadId: string, body: unknown): Promise<ThreadComment> {
    if (typeof body !== 'string' || !body.trim()) throw new ReviewError(422, 'comment-required', 'コメントを入力してください');
    if (body.length > COMMENT_MAX) throw new ReviewError(422, 'comment-too-long', `コメントは ${COMMENT_MAX} 文字以内で入力してください`);
    const t = await this.find(ws, threadId);
    const { owner, repo, pr } = ws.target;
    const r = await this.github.rest<{ id: number; node_id: string; user?: { login: string } | null; body: string; created_at: string; html_url: string }>(
      'POST',
      `/repos/${owner}/${repo}/pulls/${pr}/comments/${t.comments[0].id}/replies`,
      { body },
    );
    this.invalidate(ws.id);
    return { id: r.id, nodeId: r.node_id, author: r.user?.login ?? 'ghost', body: r.body, createdAt: r.created_at, url: r.html_url };
  }

  /** Resolve / unresolve a thread right away (GraphQL). */
  async resolve(ws: ThreadTarget, threadId: string, resolved: boolean): Promise<{ id: string; resolved: boolean }> {
    await this.find(ws, threadId);
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    await this.github.graphql(`mutation($threadId: ID!) { ${mutation}(input: { threadId: $threadId }) { thread { id isResolved } } }`, { threadId });
    this.invalidate(ws.id);
    return { id: threadId, resolved };
  }

  /** Threads of the PR; with `docPath`, only that document's threads, each placed on an element (THREAD). */
  async list(ws: ThreadTarget, docPath?: string): Promise<Thread[]> {
    const all = await this.fetchAll(ws);
    const paths = docPath ? [docPath] : [...new Set(all.map((t) => t.path))];
    const out: Thread[] = [];
    for (const p of paths) {
      const elements = p.endsWith('.md') ? await this.elements(ws, p) : [];
      for (const t of all) {
        const placement = anchorThread(t, p, elements);
        if (placement) out.push({ ...t, placement });
      }
    }
    return out;
  }

  private async elements(ws: ThreadTarget, docPath: string): Promise<DocElement[]> {
    const text = await ws.head.tryReadText(docPath).catch(() => null);
    if (text === null) return [];
    return elementsOf(parseDoc(text), text);
  }
}
