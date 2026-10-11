import pixelmatch from 'pixelmatch';
import pngjs from 'pngjs';

const { PNG } = pngjs;

export type CompareStatus = 'NoBase' | 'Match' | 'Diff';

export interface CompareResult {
  status: CompareStatus;
  /** Different pixels / all pixels (absent for NoBase). */
  ratio?: number;
  diffPng?: Buffer;
}

/** pixelmatch per-pixel color tolerance (its default). */
export const PIXEL_TOLERANCE = 0.1;

function fill(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set(rgba, i);
  return PNG.sync.write(png);
}

/** Compares a step image with its baseline (detailed design: 比較). `threshold` is the allowed ratio of different pixels. */
export function compareImages(baselinePng: Buffer | null | undefined, currentPng: Buffer, threshold: number): CompareResult {
  if (!baselinePng) return { status: 'NoBase' };
  const base = PNG.sync.read(baselinePng);
  const cur = PNG.sync.read(currentPng);
  if (base.width !== cur.width || base.height !== cur.height) {
    return { status: 'Diff', ratio: 1, diffPng: fill(Math.max(base.width, cur.width), Math.max(base.height, cur.height), [255, 0, 0, 255]) };
  }
  const { width, height } = cur;
  const diff = new PNG({ width, height });
  const n = pixelmatch(base.data, cur.data, diff.data, width, height, { threshold: PIXEL_TOLERANCE });
  const total = width * height;
  const ratio = total ? n / total : 0;
  return { status: ratio <= threshold ? 'Match' : 'Diff', ratio, diffPng: PNG.sync.write(diff) };
}
