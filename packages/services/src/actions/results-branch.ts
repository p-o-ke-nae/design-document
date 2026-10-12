import { ResultsIndexEntrySchema, type ResultsIndexEntry } from '@ddv/core';
import { GitHubError, getBranchRef, type GitHubClient } from '@ddv/github';
import { z } from 'zod';
import { GitHubRepoReader, TreeIndex, type BlobStore } from '../github-reader.ts';
import type { RunRecord } from '../history.ts';
import { notFound } from '../repo-reader.ts';
import { RESULTS_BRANCH, type RepoRef } from './gate.ts';

export const RESULTS_INDEX_VERSION = 1;
export const RESULT_ID = /^\d{1,20}-\d{1,4}$/;

/** Envelope of index.json for reading (rows are checked one by one with `ResultsIndexEntrySchema`). */
export const ResultsIndexEnvelopeSchema = z.object({
  version: z.number().int(),
  updatedAt: z.string(),
  runs: z.array(z.unknown()),
});

export interface ResultsIndex {
  version: 1;
  updatedAt: string;
  runs: ResultsIndexEntry[];
}

const CaseResultSchema = z.object({
  status: z.enum(['passed', 'failed', 'skipped', 'error']),
  durationMs: z.number().min(0),
  message: z.string().optional(),
  runner: z.string(),
  test: z.string(),
});

const StepResultMetaSchema = z.object({
  step: z.number().int().min(0),
  status: z.enum(['NoBase', 'Match', 'Diff']),
  diffRatio: z.number().optional(),
});

/** `runs/<result id>/run.json` (actions-workflow.md `CiRunRecord`) as read by the viewer. Unknown fields are kept. */
export const ActionsRunRecordSchema = z
  .object({
    id: z.string().regex(RESULT_ID),
    kind: z.literal('test').optional(),
    source: z.literal('actions'),
    actionsRunId: z.string().regex(/^\d{1,20}$/),
    actionsRequest: z.string().optional(),
    ref: z.string().optional(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    status: z.enum(['passed', 'failed', 'error']),
    request: z.object({ ids: z.array(z.string()).optional(), runner: z.string().optional() }).prefault({}),
    runners: z.array(z.object({ name: z.string(), command: z.string(), exitCode: z.number().nullable(), error: z.string().optional() })).prefault([]),
    results: z.record(z.string(), CaseResultSchema),
    log: z.array(z.string()).prefault([]),
    commit: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
    dirty: z.literal(false).optional(),
    traces: z.array(z.string()).optional(),
    snapshots: z.array(z.object({ id: z.string(), status: z.enum(['passed', 'failed', 'error']), steps: z.array(StepResultMetaSchema) }).loose()).optional(),
    warnings: z.array(z.string()).prefault([]),
  })
  .loose();

export type IndexState = 'ok' | 'noBranch' | 'indexMissing' | 'broken' | 'unsupported';

export interface IndexRead {
  state: IndexState;
  commit?: string;
  reader?: GitHubRepoReader;
  index?: ResultsIndex;
  skipped: number;
  message?: string;
}

export type RecordState = 'ok' | 'missing' | 'broken';

export interface RecordRead {
  state: RecordState;
  record?: RunRecord;
  message?: string;
}

export interface ResultsBranchReaderOptions {
  client: Pick<GitHubClient, 'rest'>;
  repo: RepoRef;
  store: BlobStore;
  hasToken: () => boolean | Promise<boolean>;
  fetch?: typeof fetch;
  rawBase?: string;
  /** Builds the reader of one commit (tests). Default: `TreeIndex.load` + `GitHubRepoReader`. */
  makeReader?: (sha: string) => Promise<GitHubRepoReader>;
}

const firstIssue = (e: z.ZodError) => {
  const i = e.issues[0];
  return i ? `${i.path.join('.') || '(root)'}: ${i.message}` : e.message;
};

/** Reads the results branch `ddv-results` through a `GitHubRepoReader` of its head commit (actions-run.md「結果ブランチの読み取り」). */
export class ResultsBranchReader {
  private last: IndexRead | null = null;
  private recordCache = new Map<string, RunRecord>();

  constructor(private readonly opts: ResultsBranchReaderOptions) {}

  /** The last `readIndex()` result (null before the first one). */
  get current(): IndexRead | null {
    return this.last;
  }

  async readIndex(): Promise<IndexRead> {
    const { owner, repo } = this.opts.repo;
    let sha: string;
    try {
      sha = await getBranchRef(this.opts.client, owner, repo, RESULTS_BRANCH);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'notFound') {
        this.last = { state: 'noBranch', skipped: 0 };
        this.recordCache.clear();
        return this.last;
      }
      throw e;
    }
    if (this.last?.commit === sha) return this.last;
    const reader = await this.makeReader(sha);
    const read = await this.parse(sha, reader);
    this.last = read;
    const keep = new Set(read.index?.runs.map((r) => r.id) ?? []);
    for (const id of [...this.recordCache.keys()]) if (!keep.has(id)) this.recordCache.delete(id);
    return read;
  }

  private async makeReader(sha: string): Promise<GitHubRepoReader> {
    if (this.opts.makeReader) return this.opts.makeReader(sha);
    const { owner, repo } = this.opts.repo;
    const tree = await TreeIndex.load(this.opts.client, owner, repo, sha, ['runs']);
    return new GitHubRepoReader({ client: this.opts.client, owner, repo, sha, tree, store: this.opts.store, hasToken: this.opts.hasToken, roots: ['runs'], fetch: this.opts.fetch, rawBase: this.opts.rawBase });
  }

  private async parse(commit: string, reader: GitHubRepoReader): Promise<IndexRead> {
    const text = await reader.tryReadText('index.json');
    if (text === null) return { state: 'indexMissing', commit, reader, skipped: 0, message: 'index.json がありません' };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { state: 'broken', commit, reader, skipped: 0, message: `JSON ではありません: ${(e as Error).message}` };
    }
    const env = ResultsIndexEnvelopeSchema.safeParse(json);
    if (!env.success) return { state: 'broken', commit, reader, skipped: 0, message: firstIssue(env.error) };
    if (env.data.version > RESULTS_INDEX_VERSION) return { state: 'unsupported', commit, reader, skipped: 0, message: `version ${env.data.version}` };
    const runs: ResultsIndexEntry[] = [];
    let skipped = 0;
    for (const row of env.data.runs) {
      const r = ResultsIndexEntrySchema.safeParse(row);
      if (r.success && RESULT_ID.test(r.data.id)) runs.push(r.data);
      else skipped++;
    }
    return { state: 'ok', commit, reader, skipped, index: { version: 1, updatedAt: env.data.updatedAt, runs } };
  }

  private reader(): GitHubRepoReader | undefined {
    return this.last?.reader;
  }

  async runFiles(id: string): Promise<string[]> {
    const r = this.reader();
    if (!r) return [];
    const base = `runs/${id}/`;
    return (await r.listFiles(`runs/${id}`)).map((p) => p.slice(base.length));
  }

  async readRecord(id: string): Promise<RecordRead> {
    const cached = this.recordCache.get(id);
    if (cached) return { state: 'ok', record: cached };
    const r = this.reader();
    if (!r) return { state: 'missing' };
    const text = await r.tryReadText(`runs/${id}/run.json`);
    if (text === null) return { state: 'missing' };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { state: 'broken', message: (e as Error).message };
    }
    const p = ActionsRunRecordSchema.safeParse(json);
    if (!p.success) return { state: 'broken', message: firstIssue(p.error) };
    if (p.data.id !== id) return { state: 'broken', message: `run.json の id が違います: ${p.data.id}` };
    const record = p.data as unknown as RunRecord;
    this.recordCache.set(id, record);
    return { state: 'ok', record };
  }

  /** Records of the ids (unreadable ones are left out). */
  async readRecords(ids: string[]): Promise<RunRecord[]> {
    const r = this.reader();
    if (!r) return [];
    const paths: string[] = [];
    for (const id of ids) {
      const p = `runs/${id}/run.json`;
      if (!this.recordCache.has(id) && (await r.stat(p))) paths.push(p);
    }
    await r.prefetch(paths).catch(() => undefined);
    const out: RunRecord[] = [];
    for (const id of ids) {
      const rr = await this.readRecord(id).catch(() => ({ state: 'broken' }) as RecordRead);
      if (rr.record) out.push(rr.record);
    }
    return out;
  }

  /** One file of a run (`RepoReadError(404)` when missing). */
  async readFile(id: string, path: string): Promise<Uint8Array> {
    const r = this.reader();
    if (!r) throw notFound(`runs/${id}/${path}`);
    return r.readBinary(`runs/${id}/${path}`);
  }
}
