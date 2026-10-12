import type { GitHubClient } from '@ddv/github';
import { StatusCommitter as ServicesStatusCommitter, type StatusCommit } from '@ddv/services';
import { FsRepoReader } from './fs-reader.ts';

/** Moved to @ddv/services (status-commit.ts); this adapter keeps the `dir`-based targets of the server. */
export { setStatus, type StatusCommit, type StatusEdit } from '@ddv/services';

export interface CommitTarget {
  headSha: string;
  dir: string;
  pr?: { headRepo: string; headRef: string } | null;
}

export class StatusCommitter extends ServicesStatusCommitter {
  constructor(github: GitHubClient) {
    super(github);
  }

  override commit(ws: CommitTarget | Parameters<ServicesStatusCommitter['commit']>[0], paths: string[], value = 'approved'): Promise<StatusCommit | null> {
    const t = 'dir' in ws ? { headSha: ws.headSha, head: new FsRepoReader(ws.dir), pr: ws.pr } : ws;
    return super.commit(t as Parameters<ServicesStatusCommitter['commit']>[0], paths, value);
  }
}