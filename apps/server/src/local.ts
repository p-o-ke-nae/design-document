import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Hono } from 'hono';
import { createApp, type ServerContext } from './app.ts';
import { defaultFolderEnv, hasConfigFile, LocalError, normalizeInput, resolveFolder, samePath, type BusyKind, type FolderEnv } from './folders.ts';
import type { RecentFolder, RecentFolders } from './recent.ts';

export { LocalError, type BusyKind, type LocalErrorCode } from './folders.ts';

export type LocalState = 'Empty' | 'Open' | 'Swapping';

export interface LocalInfo {
  state: LocalState;
  root: string | null;
  repoName: string | null;
  hasConfig: boolean;
  busy: BusyKind | null;
  recent: RecentFolder[];
}

export interface LocalOpened {
  root: string;
  repoName: string;
  hasConfig: boolean;
}

/** SSE `local` payload. */
export interface LocalEvent {
  root: string | null;
  repoName: string | null;
  generation: number;
}

export interface LocalWorkspaceOptions {
  recent: RecentFolders;
  createContext: (root: string) => Promise<ServerContext>;
  /** A context opened beforehand (tests). */
  initial?: ServerContext;
  env?: FolderEnv;
  log?: (message: string) => void;
}

export const BUSY_MESSAGES: Record<BusyKind, string> = {
  test: 'テストの実行中は選び直せません。完了してから選び直してください',
  snapshot: 'スナップショットの撮影中は選び直せません。完了してから選び直してください',
  deps: '依存の導入中は選び直せません。完了してから選び直してください',
};
export const SWAPPING_MESSAGE = 'フォルダを開いています。しばらく待ってからもう一度操作してください';
export const NO_FOLDER_MESSAGE = 'フォルダが開かれていません';

const REMOVABLE = new Set(['not-found', 'not-directory']);

/** The local workspace: one folder at a time, re-opened in place (LOCALWS). */
export class LocalWorkspace {
  state: LocalState = 'Empty';
  ctx: ServerContext | null = null;
  generation = 0;
  readonly events = new EventEmitter();
  private app: Hono | null = null;
  readonly recent: RecentFolders;
  private readonly createContext: (root: string) => Promise<ServerContext>;
  readonly env: FolderEnv;
  private readonly log: (message: string) => void;
  /** An open / close in progress (they run one at a time). */
  private op = false;

  constructor(opts: LocalWorkspaceOptions) {
    this.recent = opts.recent;
    this.createContext = opts.createContext;
    this.env = opts.env ?? defaultFolderEnv();
    this.log = opts.log ?? ((m) => console.warn(m));
    this.events.setMaxListeners(100);
    if (opts.initial) {
      this.ctx = opts.initial;
      this.app = createApp(opts.initial);
      this.state = 'Open';
    }
  }

  /** Kind of the local run in progress (test → snapshot → deps), or null. */
  busy(): BusyKind | null {
    const runs = this.ctx?.runs;
    if (!runs) return null;
    if (runs.active || runs.rerunSession) return 'test';
    if (runs.activeTask('snapshot')) return 'snapshot';
    if (runs.activeTask('deps')) return 'deps';
    return null;
  }

  private refuseWhileBusy(): void {
    if (this.op || this.state === 'Swapping') throw new LocalError(409, 'swapping', SWAPPING_MESSAGE);
  }

  private busyError(kind: BusyKind): LocalError {
    return new LocalError(409, 'busy', BUSY_MESSAGES[kind], { kind });
  }

  async open(input: unknown): Promise<LocalOpened> {
    if (typeof input !== 'string') throw new LocalError(400, 'bad-request', 'path（文字列）を指定してください');
    this.refuseWhileBusy();
    this.op = true;
    try {
      let resolved;
      try {
        resolved = await resolveFolder(input, this.env);
      } catch (e) {
        if (e instanceof LocalError && REMOVABLE.has(e.code)) {
          const target = e.target ?? normalizeInput(input, this.env);
          const before = await this.recent.load();
          const after = target ? await this.recent.remove(target) : before;
          e.removed = after.length !== before.length;
        }
        throw e;
      }
      const { root, hasConfig } = resolved;
      if (this.ctx && samePath(root, this.ctx.repoRoot, this.env.platform)) {
        await this.remember(this.ctx.repoRoot, hasConfig);
        return { root: this.ctx.repoRoot, repoName: path.basename(this.ctx.repoRoot), hasConfig };
      }
      const kind = this.busy();
      if (kind) throw this.busyError(kind);
      const prev = this.state;
      this.state = 'Swapping';
      let next: ServerContext;
      try {
        next = await this.createContext(root);
      } catch (e) {
        this.state = prev;
        throw new LocalError(422, 'config-invalid', `ddv.config.yaml を読み込めません: ${(e as Error).message}`);
      }
      this.ctx?.close();
      this.ctx = next;
      this.app = createApp(next);
      this.generation++;
      this.state = 'Open';
      await this.remember(root, hasConfig);
      this.emit();
      return { root, repoName: path.basename(root), hasConfig };
    } finally {
      this.op = false;
    }
  }

  async close(): Promise<void> {
    this.refuseWhileBusy();
    if (!this.ctx) return;
    const kind = this.busy();
    if (kind) throw this.busyError(kind);
    this.ctx.close();
    this.ctx = null;
    this.app = null;
    this.generation++;
    this.state = 'Empty';
    this.emit();
  }

  async info(): Promise<LocalInfo> {
    const root = this.ctx?.repoRoot ?? null;
    return {
      state: this.state,
      root,
      repoName: root ? path.basename(root) : null,
      hasConfig: root ? await hasConfigFile(root, this.env) : false,
      busy: this.busy(),
      recent: await this.recent.load(),
    };
  }

  async removeRecent(p: string): Promise<RecentFolder[]> {
    return this.recent.remove(p);
  }

  /** The local workspace's existing API (`createApp`); 409 when no folder is open or one is being opened. */
  async fetch(req: Request): Promise<Response> {
    if (this.state === 'Swapping') return Response.json(new LocalError(409, 'swapping', SWAPPING_MESSAGE).toJSON(), { status: 409 });
    if (!this.app) return Response.json(new LocalError(409, 'no-folder', NO_FOLDER_MESSAGE).toJSON(), { status: 409 });
    return this.app.fetch(req);
  }

  dispose(): void {
    this.ctx?.close();
    this.events.removeAllListeners();
  }

  private async remember(root: string, hasConfig: boolean): Promise<void> {
    try {
      await this.recent.add(root, hasConfig);
    } catch (e) {
      this.log(`[ddv] 最近開いたフォルダを保存できません: ${(e as Error).message}`);
    }
  }

  private emit(): void {
    const root = this.ctx?.repoRoot ?? null;
    const ev: LocalEvent = { root, repoName: root ? path.basename(root) : null, generation: this.generation };
    this.events.emit('local', ev);
  }
}
