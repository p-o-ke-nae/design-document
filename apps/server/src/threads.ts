import { promises as fs } from 'node:fs';
import path from 'node:path';
import { elementAt, elementsOf, parseDoc, type DocElement } from '@ddv/core';
import { safeJoin } from '@ddv/core/node';
import type { GitHubClient } from '@ddv/github';

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

export interface ThreadTarget {
  id: string;
  target: { owner: string; repo: string; pr?: number };
  headSha: string;
  dir: string;
}

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
    private readonly now: () => number = Date.now,
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
    let file: string;
    try {
      file = safeJoin(ws.dir, docPath);
    } catch {
      return [];
    }
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) return [];
    return elementsOf(parseDoc(text), text);
  }
}
