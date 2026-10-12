import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { DdvConfig } from '@ddv/core';
import { loadDocs, safeJoin } from '@ddv/core/node';
import { MockService, PLAYS_FILE, type PlayRecord, type PlayStore, type ScenarioDetail, type ScenarioSummary } from '@ddv/services';
import { readLock } from '@ddv/testid';
import { FsRepoReader } from './fs-reader.ts';
import type { RunManager } from './runs.ts';

/** Moved to @ddv/services (mocks.ts); the play file I/O stays on the server. */
export { PLAYS_FILE, scenarioStatus, type PlayRecord, type PlayResult, type ScenarioDetail, type ScenarioStatus, type ScenarioSummary } from '@ddv/services';

export async function readPlays(repoRoot: string): Promise<Record<string, PlayRecord>> {
  const p = safeJoin(repoRoot, PLAYS_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as Record<string, PlayRecord>;
  } catch {
    return {};
  }
}

/** `.ddv/mock-plays.json` of the working folder. */
export class FsPlayStore implements PlayStore {
  constructor(private readonly repoRoot: string) {}

  read(): Promise<Record<string, PlayRecord>> {
    return readPlays(this.repoRoot);
  }
}

let playsQueue: Promise<unknown> = Promise.resolve();

/** Records a player result (latest per test id). */
export function recordPlay(repoRoot: string, id: string, ok: boolean, failures?: unknown[], at = new Date().toISOString()): Promise<PlayRecord> {
  const next = playsQueue.then(async () => {
    const plays = await readPlays(repoRoot);
    const rec: PlayRecord = { ok, at, ...(failures?.length ? { failures } : {}) };
    plays[id] = rec;
    const p = safeJoin(repoRoot, PLAYS_FILE);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(plays, null, 2) + '\n', 'utf8');
    return rec;
  });
  playsQueue = next.catch(() => {});
  return next;
}

/** A MockService over the working folder (for callers without a ServerContext). */
export function fsMockService(repoRoot: string, config: DdvConfig, runs: Pick<RunManager, 'list'> = { list: () => [] }): MockService {
  return new MockService(new FsRepoReader(repoRoot), () => config, runs, () => loadDocs(repoRoot, config), () => readLock(repoRoot), new FsPlayStore(repoRoot));
}

export function listScenarios(repoRoot: string, config: DdvConfig, runs: RunManager): Promise<ScenarioSummary[]> {
  return fsMockService(repoRoot, config, runs).scenarios();
}

export function scenarioDetail(repoRoot: string, config: DdvConfig, id: string): Promise<ScenarioDetail | null> {
  return fsMockService(repoRoot, config).scenario(id);
}