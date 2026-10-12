import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { DdvConfig } from '@ddv/core';
import { loadDocs, safeJoin } from '@ddv/core/node';
import { LOCK_PATH, type TestIdLock } from './lock.ts';
import { formatLock, generateFrom, parseLock, type GenerateResult } from './matrix.ts';

export async function readLock(repoRoot: string): Promise<TestIdLock> {
  const p = safeJoin(repoRoot, LOCK_PATH);
  return parseLock(existsSync(p) ? await fs.readFile(p, 'utf8') : null);
}

export async function writeLock(repoRoot: string, lock: TestIdLock): Promise<void> {
  const p = safeJoin(repoRoot, LOCK_PATH);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, formatLock(lock), 'utf8');
}

/** Generates matrices for all documents; when `write` is true the lock file is updated. */
export async function generateAll(repoRoot: string, config: DdvConfig, opts: { write: boolean }): Promise<GenerateResult> {
  const original = await readLock(repoRoot);
  const docs = await loadDocs(repoRoot, config);
  const r = generateFrom(docs, config, original);
  if (opts.write && r.changed) await writeLock(repoRoot, r.lock);
  return r;
}
