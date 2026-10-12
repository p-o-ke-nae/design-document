import type { DdvConfig } from '@ddv/core';
import { DiffService as ServicesDiffService, type ChangedFiles, type DocDiff } from '@ddv/services';
import type { GitCache } from './git.ts';
import { gitChanges, liveContext, type DirTarget } from './pr-context.ts';

/** Moved to @ddv/services (pr-diff.ts); this adapter keeps the `dir`-based targets of the server. */
export {
  Hunks,
  matchDiagrams,
  type ChangedFile,
  type ChangedFiles,
  type DiagramChange,
  type DiagramDiff,
  type DocDiff,
  type Hunk,
  type Side,
} from '@ddv/services';

export type DiffTarget = DirTarget;

export class DiffService {
  private readonly svc: ServicesDiffService;

  constructor(private readonly git: GitCache) {
    this.svc = new ServicesDiffService(gitChanges(git));
  }

  files(ws: DiffTarget, config: DdvConfig): Promise<ChangedFiles> {
    return this.svc.files(liveContext(ws, this.git), config);
  }

  docDiff(ws: DiffTarget, config: DdvConfig, docPath: string): Promise<DocDiff> {
    return this.svc.docDiff(liveContext(ws, this.git), config, docPath);
  }
}