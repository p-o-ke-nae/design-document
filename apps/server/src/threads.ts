import type { GitHubClient } from '@ddv/github';
import { ThreadService as ServicesThreadService, type Thread, type ThreadComment } from '@ddv/services';
import { liveContext, type DirTarget } from './pr-context.ts';

/** Moved to @ddv/services (threads.ts); this adapter keeps the `dir`-based targets of the server. */
export { anchorThread, THREAD_CACHE_MS, type Thread, type ThreadComment, type ThreadPlacement } from '@ddv/services';

export type ThreadTarget = Pick<DirTarget, 'id' | 'target' | 'headSha' | 'dir'>;

const ctx = (ws: ThreadTarget) => liveContext(ws as DirTarget);

export class ThreadService {
  private readonly svc: ServicesThreadService;

  constructor(gh: GitHubClient, now: () => number = () => Date.now()) {
    this.svc = new ServicesThreadService(gh, now);
  }

  invalidate(wsId: string): void {
    this.svc.invalidate(wsId);
  }

  reply(ws: ThreadTarget, threadId: string, body: unknown): Promise<ThreadComment> {
    return this.svc.reply(ctx(ws), threadId, body);
  }

  resolve(ws: ThreadTarget, threadId: string, resolved: boolean): Promise<{ id: string; resolved: boolean }> {
    return this.svc.resolve(ctx(ws), threadId, resolved);
  }

  list(ws: ThreadTarget, docPath?: string): Promise<Thread[]> {
    return this.svc.list(ctx(ws), docPath);
  }
}