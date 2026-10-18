// Saving evidence outputs under the trace directory (detailed design evidence-trace.md#証跡の保存・#大きさの上限).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EvidenceFile, EvidenceKind } from '@ddv/mock/trace-format';
import type { Cell } from './index.ts';

/** A provider output as the store receives it. `ext` keeps the extension of a command's output file (`text`). */
export type StoreOutput =
  | { kind: 'image'; path: string }
  | { kind: 'table'; columns: string[]; rows: Cell[][] }
  | { kind: 'json'; data: unknown }
  | { kind: 'text'; text: string; ext?: string }
  | { kind: 'file'; path: string };

export interface StoreLimits {
  maxBytes: number;
  maxFileBytes: number;
}

export interface SavedFiles {
  files: EvidenceFile[];
  /** A table / text / json body was cut to `maxBytes`. */
  truncated: boolean;
}

export const SAVE_ERROR = '証跡を保存できません';
const NAME_LENGTH = 40;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const cleanName = (s: string) => s.replace(BAD_CHARS, '_').trim().replace(/\.+$/, '').trim();

/** Name part of evidence files (FNAME): label → use when empty, first 40 code points, reserved names prefixed with `_`. */
export function evidenceName(label: string, use: string): string {
  const cleaned = cleanName(label) || cleanName(use) || 'evidence';
  const cut = Array.from(cleaned).slice(0, NAME_LENGTH).join('');
  return RESERVED.test(cut.split('.')[0]) ? `_${cut}` : cut;
}

/** `step-seq-name[-k].ext` (`k` from 1 when there are two or more outputs). */
export function evidenceFileName(step: number, seq: number, name: string, ext: string, k: number | null): string {
  return `${step}-${seq}-${name}${k === null ? '' : `-${k}`}.${ext}`;
}

/** Cuts a string to `max` UTF-8 bytes without splitting a character. */
export function cutUtf8(text: string, max: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return { text, cut: false };
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), cut: true };
}

/** `{ columns, rows }` as JSON within `max` bytes, removing rows from the end. */
export function fitTable(columns: string[], rows: Cell[][], max: number): { body: string; cut: boolean } {
  const full = JSON.stringify({ columns, rows });
  if (Buffer.byteLength(full) <= max) return { body: full, cut: false };
  let lo = 0;
  let hi = rows.length - 1;
  let best = JSON.stringify({ columns, rows: [] });
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const body = JSON.stringify({ columns, rows: rows.slice(0, mid) });
    if (Buffer.byteLength(body) <= max) {
      best = body;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return { body: best, cut: true };
}

const extOf = (p: string) => path.extname(p).slice(1).toLowerCase();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Planned {
  kind: EvidenceKind;
  ext: string;
  mime: string;
  write: { body: string } | { copy: string } | null;
  bytes: number;
  omitted?: 'too-large';
  cut?: boolean;
}

/** Writes outputs into `<traceDir>/<key>/evidence/` and returns their `EvidenceFile`s (paths relative to `traceDir`). */
export class EvidenceStore {
  readonly dir: string;

  constructor(
    readonly traceDir: string,
    readonly key: string,
    private readonly limits: StoreLimits,
  ) {
    this.dir = path.join(traceDir, key, 'evidence');
  }

  async save(step: number, seq: number, label: string, use: string, outputs: readonly StoreOutput[]): Promise<SavedFiles> {
    try {
      return await this.write(step, seq, evidenceName(label, use), outputs);
    } catch (e) {
      throw new Error(`${SAVE_ERROR}：${errText(e)}`, { cause: e });
    }
  }

  private async write(step: number, seq: number, name: string, outputs: readonly StoreOutput[]): Promise<SavedFiles> {
    await fs.mkdir(this.dir, { recursive: true });
    const files: EvidenceFile[] = [];
    let truncated = false;
    for (let i = 0; i < outputs.length; i++) {
      const p = await this.plan(outputs[i]);
      if (p.cut) truncated = true;
      const fileName = evidenceFileName(step, seq, name, p.ext, outputs.length > 1 ? i + 1 : null);
      if (p.write) {
        const abs = path.join(this.dir, fileName);
        const tmp = `${abs}.tmp`;
        if ('body' in p.write) await fs.writeFile(tmp, p.write.body, 'utf8');
        else await fs.copyFile(p.write.copy, tmp);
        await fs.rename(tmp, abs);
      }
      files.push({ path: path.posix.join(this.key.split(path.sep).join('/'), 'evidence', fileName), kind: p.kind, mime: p.mime, bytes: p.bytes, ...(p.omitted ? { omitted: p.omitted } : {}) });
    }
    return { files, truncated };
  }

  private async plan(o: StoreOutput): Promise<Planned> {
    const { maxBytes, maxFileBytes } = this.limits;
    switch (o.kind) {
      case 'table': {
        const { body, cut } = fitTable(o.columns, o.rows, maxBytes);
        return { kind: 'table', ext: 'table.json', mime: 'application/json', write: { body }, bytes: Buffer.byteLength(body), cut };
      }
      case 'text': {
        const { text, cut } = cutUtf8(o.text, maxBytes);
        const ext = o.ext === 'log' || o.ext === 'txt' ? o.ext : 'txt';
        return { kind: 'text', ext, mime: 'text/plain', write: { body: text }, bytes: Buffer.byteLength(text), cut };
      }
      case 'json': {
        const body = JSON.stringify(o.data, null, 2) ?? 'null';
        if (Buffer.byteLength(body) <= maxBytes) return { kind: 'json', ext: 'json', mime: 'application/json', write: { body }, bytes: Buffer.byteLength(body) };
        const { text } = cutUtf8(body, maxBytes);
        return { kind: 'text', ext: 'txt', mime: 'text/plain', write: { body: text }, bytes: Buffer.byteLength(text), cut: true };
      }
      case 'image':
      case 'file': {
        const src = o.path;
        const size = (await fs.stat(src)).size;
        let ext = extOf(src);
        let kind: EvidenceKind = o.kind;
        let mime = 'application/octet-stream';
        if (kind === 'image' && IMAGE_MIME[ext]) mime = IMAGE_MIME[ext];
        else kind = 'file';
        if (!ext) ext = 'bin';
        if (size > maxFileBytes) return { kind, ext, mime, write: null, bytes: size, omitted: 'too-large' };
        return { kind, ext, mime, write: { copy: src }, bytes: size };
      }
    }
  }
}
