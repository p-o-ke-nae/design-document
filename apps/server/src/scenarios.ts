import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { DdvConfig } from '@ddv/core';
import { loadDocs, safeJoin, type LintIssue } from '@ddv/core/node';
import { readLock } from '@ddv/testid';
import {
  checkMocks,
  findScenarioFiles,
  mockTargets,
  parseScenarioFile,
  pathSpecs,
  scenarioIdOf,
  targetDiagram,
  type PathTransition,
  type Scenario,
  type ScenarioEntry,
  type ScenarioFile,
} from '@ddv/mock';
import type { RunManager } from './runs.ts';

export const PLAYS_FILE = '.ddv/mock-plays.json';

export type ScenarioStatus = 'Unverified' | 'Passed' | 'Failed' | 'Retired';

export interface PlayRecord {
  ok: boolean;
  at: string;
  failures?: unknown[];
}

export interface PlayResult {
  ok: boolean;
  at: string;
}

export async function readPlays(repoRoot: string): Promise<Record<string, PlayRecord>> {
  const p = safeJoin(repoRoot, PLAYS_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as Record<string, PlayRecord>;
  } catch {
    return {};
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

/**
 * Scenario state (basic design: シナリオの状態). The latest play / E2E result decides Passed or Failed;
 * a file modified after that result (edit or regeneration) is Unverified; files in `_retired/` are Retired.
 */
export function scenarioStatus(input: { retired: boolean; mtimeMs: number; results: Array<PlayResult | null | undefined> }): ScenarioStatus {
  if (input.retired) return 'Retired';
  let latest: PlayResult | null = null;
  for (const r of input.results) if (r && (!latest || Date.parse(r.at) > Date.parse(latest.at))) latest = r;
  if (!latest) return 'Unverified';
  if (input.mtimeMs > Date.parse(latest.at)) return 'Unverified';
  return latest.ok ? 'Passed' : 'Failed';
}

/** Latest E2E results of scenario-linked playwright runners, per test id. */
function e2eResults(runs: RunManager, config: DdvConfig): Record<string, PlayResult> {
  const names = new Set(config.runners.filter((r) => r.type === 'playwright' && r.scenarios).map((r) => r.name));
  const out: Record<string, PlayResult> = {};
  for (const run of runs.list().reverse()) {
    for (const [id, r] of Object.entries(run.results)) {
      if (!names.has(r.runner) || r.status === 'skipped') continue;
      out[id] = { ok: r.status === 'passed', at: run.finishedAt ?? run.startedAt };
    }
  }
  return out;
}

const issueText = (i: { line?: number; message: string }) => `${i.line ? `${i.line} 行目: ` : ''}${i.message}`;

interface LoadedScenario {
  entry: ScenarioEntry;
  id: string;
  file: ScenarioFile;
  mtimeMs: number;
}

async function loadAll(repoRoot: string, config: DdvConfig): Promise<LoadedScenario[]> {
  const out: LoadedScenario[] = [];
  for (const entry of findScenarioFiles(repoRoot, config, { retired: true })) {
    const abs = safeJoin(repoRoot, entry.file);
    const [text, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
    const file = parseScenarioFile(text, entry.file);
    out.push({ entry, id: file.scenario?.id ?? scenarioIdOf(text) ?? path.posix.basename(entry.file).replace(/\.ya?ml$/, ''), file, mtimeMs: st.mtimeMs });
  }
  return out;
}

async function lintByFile(repoRoot: string, config: DdvConfig): Promise<Map<string, LintIssue[]>> {
  const docs = await loadDocs(repoRoot, config);
  const issues = await checkMocks(repoRoot, config, docs);
  const out = new Map<string, LintIssue[]>();
  for (const i of issues) out.set(i.path, [...(out.get(i.path) ?? []), i]);
  return out;
}

function issuesOf(s: LoadedScenario, lint: Map<string, LintIssue[]>): string[] {
  if (!s.file.scenario) return s.file.issues.map(issueText);
  return s.entry.retired ? [] : (lint.get(s.entry.file) ?? []).map(issueText);
}

export interface ScenarioSummary {
  id: string;
  title: string;
  mock: string;
  file: string;
  status: ScenarioStatus;
  issues: string[];
}

export async function listScenarios(repoRoot: string, config: DdvConfig, runs: RunManager): Promise<ScenarioSummary[]> {
  const [all, lint, plays] = await Promise.all([loadAll(repoRoot, config), lintByFile(repoRoot, config), readPlays(repoRoot)]);
  const e2e = e2eResults(runs, config);
  return all.map((s) => ({
    id: s.id,
    title: s.file.scenario?.title ?? '',
    mock: s.entry.mock,
    file: s.entry.file,
    status: scenarioStatus({ retired: s.entry.retired, mtimeMs: s.mtimeMs, results: [plays[s.id], e2e[s.id]] }),
    issues: issuesOf(s, lint),
  }));
}

export interface ScenarioDetail {
  id: string;
  title: string;
  mock: string;
  /** html path relative to mocksRoot, e.g. `order/index.html`. */
  mockPath: string;
  /** Document referencing the mock (`::mock`), or null. */
  doc: string | null;
  /** Screen transition diagram id in `doc`, or null. */
  diagram: string | null;
  scenario: Scenario | null;
  transitions: PathTransition[];
  edges: number[];
  issues: string[];
  file: string;
  retired: boolean;
}

export async function scenarioDetail(repoRoot: string, config: DdvConfig, id: string): Promise<ScenarioDetail | null> {
  const all = await loadAll(repoRoot, config);
  const s = all.find((x) => x.id === id && !x.entry.retired) ?? all.find((x) => x.id === id);
  if (!s) return null;
  const docs = await loadDocs(repoRoot, config);
  const target = mockTargets(docs).find((t) => t.name === s.entry.mock);
  const sd = target ? targetDiagram(target) : null;
  const spec = target && sd ? pathSpecs(target.doc, sd.diagram, await readLock(repoRoot), config).find((p) => p.id === id) : undefined;
  const lint = s.file.scenario && !s.entry.retired ? await lintByFile(repoRoot, config) : new Map<string, LintIssue[]>();
  return {
    id,
    title: s.file.scenario?.title ?? '',
    mock: s.entry.mock,
    mockPath: target?.target ?? `${s.entry.mock}/index.html`,
    doc: target?.doc.path ?? null,
    diagram: sd?.diagram.id ?? null,
    scenario: s.file.scenario ?? null,
    transitions: spec?.transitions ?? [],
    edges: spec?.edges ?? [],
    issues: issuesOf(s, lint),
    file: s.entry.file,
    retired: s.entry.retired,
  };
}
