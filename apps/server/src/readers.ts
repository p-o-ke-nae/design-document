import path from 'node:path';
import type { RepoReader } from '@ddv/services';
import { FsRepoReader } from './fs-reader.ts';
import { GitRevReader, type GitRevSource } from './git-reader.ts';
import { WorkspaceError, type Workspace } from './workspaces.ts';

export type ReaderSide = 'RIGHT' | 'LEFT';

/** The local folder is not open (409 `no-folder`). The local-folder slice owns the real `LocalError`; same status / code / message. */
export class NoFolderError extends Error {
  readonly status = 409 as const;
  readonly code = 'no-folder' as const;
  constructor() {
    super('フォルダが開かれていません');
    this.name = 'LocalError';
  }
}

/** What ReaderFactory needs of `LocalWorkspace` (`ctx` = the open folder; `generation` changes when it is switched). */
export interface LocalFolder {
  readonly ctx: { repoRoot: string } | null;
  readonly generation: number;
}

export interface ReaderFactoryOptions {
  workspaces?: { get(id: string): Pick<Workspace, 'id' | 'state' | 'dir' | 'generation' | 'mergeBase' | 'target'> | undefined };
  git?: GitRevSource;
  local?: LocalFolder | (() => LocalFolder | null) | null;
}

/** DD-SVC-READERSEL: the reader of a workspace side (`wsId` = '' is the local folder). */
export class ReaderFactory {
  private readonly heads = new Map<string, { gen: number; reader: FsRepoReader }>();
  private readonly bases = new Map<string, GitRevReader>();
  private localHead: { root: string; gen: number; reader: FsRepoReader } | null = null;

  constructor(private readonly opts: ReaderFactoryOptions) {}

  private local(): LocalFolder | null {
    const l = this.opts.local;
    return typeof l === 'function' ? l() : (l ?? null);
  }

  forWorkspace(wsId: string, side: ReaderSide): RepoReader | null {
    if (!wsId) {
      const local = this.local();
      if (!local?.ctx) throw new NoFolderError();
      if (side !== 'RIGHT') return null;
      const root = local.ctx.repoRoot;
      if (!this.localHead || this.localHead.root !== root || this.localHead.gen !== local.generation) this.localHead = { root, gen: local.generation, reader: new FsRepoReader(root) };
      return this.localHead.reader;
    }
    const ws = this.opts.workspaces?.get(wsId);
    if (!ws) throw new WorkspaceError(404, 'not-found', `ワークスペースがありません: ${wsId}`);
    if (ws.state !== 'Ready' && ws.state !== 'Stale') throw new WorkspaceError(409, 'not-ready', `ワークスペースの準備ができていません（${ws.state}）`);
    return this.readerOf(ws, side);
  }

  /** The reader of an already validated workspace (no state check; used by live PR contexts during a refresh). */
  readerOf(ws: Pick<Workspace, 'id' | 'dir' | 'generation' | 'mergeBase' | 'target'>, side: ReaderSide): RepoReader | null {
    if (side === 'RIGHT') {
      let e = this.heads.get(ws.id);
      if (!e || e.gen !== ws.generation || e.reader.root !== path.resolve(ws.dir)) {
        e = { gen: ws.generation, reader: new FsRepoReader(ws.dir) };
        this.heads.set(ws.id, e);
      }
      return e.reader;
    }
    if (!ws.mergeBase || !this.opts.git) return null;
    const key = `${ws.target.owner}/${ws.target.repo}@${ws.mergeBase}`;
    let r = this.bases.get(key);
    if (!r) {
      r = new GitRevReader(this.opts.git, ws.target.owner, ws.target.repo, ws.mergeBase);
      this.bases.set(key, r);
      if (this.bases.size > 50) this.bases.delete(this.bases.keys().next().value!);
    }
    return r;
  }
  /** Drops the readers of a closed workspace. */
  forget(wsId: string): void {
    this.heads.delete(wsId);
  }
}
