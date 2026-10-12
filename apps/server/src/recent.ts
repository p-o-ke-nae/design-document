import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { samePath } from './folders.ts';

export const RecentFolderSchema = z.object({
  path: z.string().min(1),
  openedAt: z.string().datetime(),
  hasConfig: z.boolean(),
});
export const RecentFileSchema = z.object({
  version: z.literal(1),
  folders: z.array(z.unknown()),
});
export const MAX_RECENT = 10;

export type RecentFolder = z.infer<typeof RecentFolderSchema>;

export const RECENT_BROKEN_MESSAGE = '[ddv] 最近開いたフォルダ（recent.json）を読めません。作り直します';

export interface RecentFoldersOptions {
  platform?: NodeJS.Platform;
  now?: () => Date;
  warn?: (message: string) => void;
}

/** `<DDV_HOME>/recent.json`: the folders opened in the local workspace, newest first (RECENT). */
export class RecentFolders {
  private warned = false;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;

  constructor(
    readonly file: string,
    opts: RecentFoldersOptions = {},
  ) {
    this.platform = opts.platform ?? process.platform;
    this.now = opts.now ?? (() => new Date());
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  async load(): Promise<RecentFolder[]> {
    return (await this.read()).list;
  }

  async add(root: string, hasConfig: boolean): Promise<RecentFolder[]> {
    const list = (await this.read()).list.filter((f) => !samePath(f.path, root, this.platform));
    list.unshift({ path: root, openedAt: this.now().toISOString(), hasConfig });
    const next = list.slice(0, MAX_RECENT);
    await this.save(next);
    return next;
  }

  async remove(p: string): Promise<RecentFolder[]> {
    const { list, broken } = await this.read();
    const next = list.filter((f) => !samePath(f.path, p, this.platform));
    // A broken file is replaced on the next write.
    if (broken || next.length !== list.length) await this.save(next);
    return next;
  }

  private async read(): Promise<{ list: RecentFolder[]; broken: boolean }> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { list: [], broken: false };
      return this.broken();
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return this.broken();
    }
    const file = RecentFileSchema.safeParse(data);
    if (!file.success) return this.broken();
    const list: RecentFolder[] = [];
    for (const item of file.data.folders) {
      const r = RecentFolderSchema.safeParse(item);
      if (r.success) list.push(r.data);
    }
    return { list, broken: false };
  }

  private broken(): { list: RecentFolder[]; broken: boolean } {
    if (!this.warned) this.warn(RECENT_BROKEN_MESSAGE);
    this.warned = true;
    return { list: [], broken: true };
  }

  private async save(list: RecentFolder[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, folders: list }, null, 2) + '\n');
    await fs.rename(tmp, this.file);
  }
}
