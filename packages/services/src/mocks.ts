import type { DdvConfig, DocEntry, LintIssue } from '@ddv/core';
import {
  analyzeMockHtml,
  checkMocksWith,
  isScenarioFileName,
  locate as locateMockElement,
  mockTargets,
  mocksRootOf,
  NO_SOURCE_MESSAGE,
  parseScenarioFile,
  pathSpecs,
  RETIRED_DIR,
  scenarioIdOf,
  scenariosDir,
  targetDiagram,
  build as buildSuggestion,
  TuneError,
  validatePatch,
  type MockCheckIo,
  type PathTransition,
  type Scenario,
  type ScenarioFile,
} from '@ddv/mock/browser';
import type { TestIdLock } from '@ddv/testid/core';
import { ServiceError } from './errors.ts';
import type { LocalRuns } from './history.ts';
import { normalizeRepoPath, isUnder } from './repo-path.ts';
import type { RepoReader } from './repo-reader.ts';

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

/** Results of the scenario player (server: `FsPlayStore` = `.ddv/mock-plays.json`). */
export interface PlayStore {
  read(): Promise<Record<string, PlayRecord>>;
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

export interface ScenarioEntry {
  mock: string;
  file: string;
  retired: boolean;
}

export interface ScenarioSummary {
  id: string;
  title: string;
  mock: string;
  file: string;
  status: ScenarioStatus;
  issues: string[];
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

export interface MockSourceBody {
  mock?: unknown;
  path?: unknown;
  expect?: { tag?: unknown; testid?: unknown };
  patch?: unknown;
}

const issueText = (i: { line?: number; message: string }) => `${i.line ? `${i.line} 行目: ` : ''}${i.message}`;

interface LoadedScenario {
  entry: ScenarioEntry;
  id: string;
  file: ScenarioFile;
  mtimeMs: number;
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** `findScenarioFiles` over a reader: `<mocksRoot>/<mock>/scenarios/*.yaml` (and `_retired/*.yaml` when `retired`). */
export async function findScenarioFilesIn(reader: RepoReader, config: DdvConfig, opts: { retired?: boolean } = {}): Promise<ScenarioEntry[]> {
  const root = mocksRootOf(config);
  const byMock = new Map<string, { current: string[]; retired: string[] }>();
  const base = normalizeRepoPath(root);
  for (const f of await reader.listFiles(root)) {
    const rest = (base ? f.slice(base.length + 1) : f).split('/');
    const [mock, dir, a, b] = rest;
    if (!mock || mock.startsWith('_') || mock.startsWith('.') || dir !== 'scenarios') continue;
    const slot = byMock.get(mock) ?? { current: [], retired: [] };
    byMock.set(mock, slot);
    if (rest.length === 3 && isScenarioFileName(a)) slot.current.push(a);
    else if (rest.length === 4 && a === RETIRED_DIR && isScenarioFileName(b)) slot.retired.push(b);
  }
  const out: ScenarioEntry[] = [];
  for (const mock of [...byMock.keys()].sort()) {
    const dir = `${root}/${mock}/scenarios`;
    const slot = byMock.get(mock)!;
    for (const f of slot.current.sort()) out.push({ mock, file: `${dir}/${f}`, retired: false });
    if (opts.retired) for (const f of slot.retired.sort()) out.push({ mock, file: `${dir}/${RETIRED_DIR}/${f}`, retired: true });
  }
  return out;
}

/** `checkMocks` file access over a reader. */
export function readerMockCheckIo(reader: RepoReader, config: DdvConfig): MockCheckIo {
  return {
    dirExists: async (rel) => (await reader.listFiles(rel)).length > 0,
    mockModel: async (target) => {
      const text = await reader.tryReadText(`${config.mocksRoot}/${target}`);
      return text === null ? null : analyzeMockHtml(text);
    },
    scenarioFiles: async (mock) => {
      const dir = scenariosDir(config, mock);
      const d = normalizeRepoPath(dir);
      return (await reader.listFiles(dir))
        .filter((f) => !f.slice(d.length + 1).includes('/') && isScenarioFileName(baseName(f)))
        .map((f) => `${dir}/${baseName(f)}`)
        .sort();
    },
    readText: (rel) => reader.readText(rel),
    tryReadText: (rel) => reader.tryReadText(rel),
  };
}

/** Mocks, their scenarios and the tune mode's source lookup. */
export class MockService {
  constructor(
    private readonly reader: RepoReader,
    private readonly getConfig: () => DdvConfig,
    private readonly runs: Pick<LocalRuns, 'list'>,
    private readonly docs: () => Promise<DocEntry[]>,
    private readonly lock: () => Promise<TestIdLock>,
    private readonly plays?: PlayStore,
  ) {}

  /** html files under mocksRoot. */
  mocks(): Promise<string[]> {
    return this.reader.listFiles(this.getConfig().mocksRoot, (rel) => rel.endsWith('.html'));
  }

  /** Tune mode (DD-TUNE): source lines of a picked mock element, and the suggestion for a patch. */
  async source(body: MockSourceBody | null): Promise<unknown> {
    const elPath = body?.path;
    const want = body?.expect;
    if (
      !body ||
      typeof body.mock !== 'string' ||
      !body.mock.endsWith('.html') ||
      !Array.isArray(elPath) ||
      !elPath.every((i) => Number.isInteger(i) && i >= 0) ||
      !want ||
      typeof want.tag !== 'string' ||
      !want.tag ||
      (want.testid !== undefined && typeof want.testid !== 'string')
    )
      throw new ServiceError(400, '', 'mock（.html）・path（0 以上の整数の配列）・expect.tag が必要です');
    let file: string;
    try {
      const root = normalizeRepoPath(this.getConfig().mocksRoot);
      file = normalizeRepoPath(`${root}/${normalizeRepoPath(body.mock)}`);
      if (!isUnder(file, root)) throw new Error();
    } catch {
      throw new ServiceError(400, '', `モックの外は指定できません: ${body.mock}`);
    }
    const html = await this.reader.tryReadText(file);
    if (html === null) throw new ServiceError(404, '', `モックが見つかりません: ${body.mock}`);
    const el = locateMockElement(html, elPath as number[], { tag: want.tag, testid: want.testid as string | undefined });
    if ('reason' in el) throw new ServiceError(422, 'no-source', NO_SOURCE_MESSAGE[el.reason]);
    const element = { path: el.path, tag: el.tag, startLine: el.startLine, endLine: el.endLine, textCount: el.textCount, source: el.source, sourceStartLine: el.sourceStartLine };
    if (body.patch === undefined) return { file, element };
    const current = Object.fromEntries(el.startTag.attrs.map((a) => [a.name, a.value ? html.slice(a.value.start, a.value.end) : '']));
    const { patch, issues } = validatePatch(body.patch, el.tag, current);
    if (issues.length) throw new ServiceError(400, 'invalid-patch', issues.map((i) => i.message).join('／'), { issues });
    try {
      return { file, element, suggestion: buildSuggestion(html, el, patch) };
    } catch (e) {
      if (e instanceof TuneError) throw new ServiceError(400, e.code, e.message);
      throw e;
    }
  }

  private async loadAll(): Promise<LoadedScenario[]> {
    const out: LoadedScenario[] = [];
    for (const entry of await findScenarioFilesIn(this.reader, this.getConfig(), { retired: true })) {
      const [text, st] = await Promise.all([this.reader.readText(entry.file), this.reader.stat(entry.file)]);
      const file = parseScenarioFile(text, entry.file);
      out.push({ entry, id: file.scenario?.id ?? scenarioIdOf(text) ?? baseName(entry.file).replace(/\.ya?ml$/, ''), file, mtimeMs: st?.mtimeMs ?? 0 });
    }
    return out;
  }

  private async lintByFile(): Promise<Map<string, LintIssue[]>> {
    const config = this.getConfig();
    const issues = await checkMocksWith(readerMockCheckIo(this.reader, config), config, await this.docs(), await this.lock());
    const out = new Map<string, LintIssue[]>();
    for (const i of issues) out.set(i.path, [...(out.get(i.path) ?? []), i]);
    return out;
  }

  /** Latest E2E results of scenario-linked playwright runners, per test id. */
  private e2eResults(): Record<string, PlayResult> {
    const names = new Set(this.getConfig().runners.filter((r) => r.type === 'playwright' && r.scenarios).map((r) => r.name));
    const out: Record<string, PlayResult> = {};
    for (const run of [...this.runs.list()].reverse()) {
      for (const [id, r] of Object.entries(run.results)) {
        if (!names.has(r.runner) || r.status === 'skipped') continue;
        out[id] = { ok: r.status === 'passed', at: run.finishedAt ?? run.startedAt };
      }
    }
    return out;
  }

  async scenarios(): Promise<ScenarioSummary[]> {
    const [all, lint, plays] = await Promise.all([this.loadAll(), this.lintByFile(), this.plays?.read() ?? Promise.resolve({} as Record<string, PlayRecord>)]);
    const e2e = this.e2eResults();
    return all.map((s) => ({
      id: s.id,
      title: s.file.scenario?.title ?? '',
      mock: s.entry.mock,
      file: s.entry.file,
      status: scenarioStatus({ retired: s.entry.retired, mtimeMs: s.mtimeMs, results: [plays[s.id], e2e[s.id]] }),
      issues: issuesOf(s, lint),
    }));
  }

  async scenario(id: string): Promise<ScenarioDetail | null> {
    const config = this.getConfig();
    const all = await this.loadAll();
    const s = all.find((x) => x.id === id && !x.entry.retired) ?? all.find((x) => x.id === id);
    if (!s) return null;
    const docs = await this.docs();
    const target = mockTargets(docs).find((t) => t.name === s.entry.mock);
    const sd = target ? targetDiagram(target) : null;
    const spec = target && sd ? pathSpecs(target.doc, sd.diagram, await this.lock(), config).find((p) => p.id === id) : undefined;
    const lint = s.file.scenario && !s.entry.retired ? await this.lintByFile() : new Map<string, LintIssue[]>();
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
}

function issuesOf(s: LoadedScenario, lint: Map<string, LintIssue[]>): string[] {
  if (!s.file.scenario) return s.file.issues.map(issueText);
  return s.entry.retired ? [] : (lint.get(s.entry.file) ?? []).map(issueText);
}
