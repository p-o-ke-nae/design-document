import { GitHubError } from '@ddv/github';
import { describe, expect, it } from 'vitest';
import { MemoryBlobStore, type GitHubRepoReader } from '../github-reader.ts';
import { ResultsBranchReader } from './results-branch.ts';

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  actionsRunId: id.split('-')[0],
  commit: 'a'.repeat(40),
  ref: 'main',
  startedAt: '2025-01-01T00:00:00Z',
  status: 'passed',
  counts: { passed: 1, failed: 0, error: 0, skipped: 0 },
  traces: true,
  ...extra,
});

const runJson = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  source: 'actions',
  actionsRunId: id.split('-')[0],
  startedAt: '2025-01-01T00:00:00Z',
  status: 'passed',
  results: { 'DD-A-B-T001': { status: 'passed', durationMs: 1, runner: 'r', test: 't' } },
  futureField: 1,
  ...extra,
});

/** A fake results branch: ref sha → files. */
function setup(commits: Record<string, Record<string, string>>, refs: { sha?: string; error?: GitHubError }) {
  const made: string[] = [];
  const reader = new ResultsBranchReader({
    client: {
      rest: async <T,>(_m: string, path: string) => {
        if (!path.endsWith('/git/ref/heads/ddv-results')) throw new Error(`unexpected ${path}`);
        if (refs.error) throw refs.error;
        return { object: { sha: refs.sha } } as T;
      },
    },
    repo: { owner: 'acme', repo: 'order-app' },
    store: new MemoryBlobStore(),
    hasToken: () => true,
    makeReader: async (sha) => {
      made.push(sha);
      const files = commits[sha] ?? {};
      return {
        sha,
        tryReadText: async (p: string) => files[p] ?? null,
        listFiles: async (dir: string) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)),
        stat: async (p: string) => (p in files ? { kind: 'file' } : null),
        prefetch: async () => undefined,
        readBinary: async (p: string) => {
          if (!(p in files)) throw new Error('404');
          return new TextEncoder().encode(files[p]);
        },
      } as unknown as GitHubRepoReader;
    },
  });
  return { reader, made };
}

const index = (runs: unknown[], version = 1) => JSON.stringify({ version, updatedAt: '2025-01-01T00:00:00Z', runs });

describe('ResultsBranchReader.readIndex', () => {
  it('[DD-ACTSVC-READIDX-P001][DD-ACTSVC-READIDX-T001][DD-ACTSVC-READIDX-T002][DD-ACTSVC-READIDX-T003] 結果ブランチが無い（404）と noBranch', async () => {
    const { reader } = setup({}, { error: new GitHubError('notFound', 404, '見つかりません: Not Found') });
    expect(await reader.readIndex()).toEqual({ state: 'noBranch', skipped: 0 });
  });

  it('[DD-ACTSVC-READIDX-P002][DD-ACTSVC-READIDX-T004] 404 以外の失敗は GitHubError を投げる', async () => {
    const { reader } = setup({}, { error: new GitHubError('network', 502, 'GitHub との通信に失敗しました: x') });
    await expect(reader.readIndex()).rejects.toMatchObject({ kind: 'network' });
  });

  it('[DD-ACTSVC-READIDX-P003][DD-ACTSVC-READIDX-T005][DD-ACTSVC-READIDX-T006] 前回と同じコミットなら読み手を作らず前回の IndexRead を返す', async () => {
    const refs = { sha: 'c1' };
    const { reader, made } = setup({ c1: { 'index.json': index([entry('1-1')]) } }, refs);
    const first = await reader.readIndex();
    const second = await reader.readIndex();
    expect(second).toBe(first);
    expect(made).toEqual(['c1']);
  });

  it('[DD-ACTSVC-READIDX-P008][DD-ACTSVC-READIDX-T007][DD-ACTSVC-READIDX-T008][DD-ACTSVC-READIDX-T017] コミットが変われば読み手を作り直し、index.json が無ければ indexMissing', async () => {
    const refs = { sha: 'c1' };
    const { reader, made } = setup({ c1: { 'index.json': index([]) }, c2: {} }, refs);
    expect((await reader.readIndex()).state).toBe('ok');
    refs.sha = 'c2';
    const r = await reader.readIndex();
    expect(r).toMatchObject({ state: 'indexMissing', commit: 'c2', skipped: 0 });
    expect(made).toEqual(['c1', 'c2']);
  });

  it('[DD-ACTSVC-READIDX-P009][DD-ACTSVC-READIDX-T018][DD-ACTSVC-READIDX-T012] JSON でない・外枠のスキーマに合わない index.json は broken', async () => {
    const refs = { sha: 'c1' };
    const { reader } = setup({ c1: { 'index.json': '{' }, c2: { 'index.json': JSON.stringify({ version: '1', runs: [] }) } }, refs);
    expect((await reader.readIndex()).state).toBe('broken');
    refs.sha = 'c2';
    const r = await reader.readIndex();
    expect(r.state).toBe('broken');
    expect(r.message).toMatch(/version/);
  });

  it('[DD-ACTSVC-READIDX-P010][DD-ACTSVC-READIDX-T013][DD-ACTSVC-READIDX-T014] version が 1 より大きければ unsupported', async () => {
    const { reader } = setup({ c1: { 'index.json': index([entry('1-1')], 2) } }, { sha: 'c1' });
    expect((await reader.readIndex()).state).toBe('unsupported');
  });

  it('[DD-ACTSVC-READIDX-P011][DD-ACTSVC-READIDX-T015][DD-ACTSVC-READIDX-T016] 行を 1 件ずつ検査し、合わない行は除いて skipped に数える', async () => {
    const { reader } = setup({ c1: { 'index.json': index([entry('2-1'), { id: 'bad' }, entry('1-1', { status: 'running' }), entry('3-1', { trimmed: true })]) } }, { sha: 'c1' });
    const r = await reader.readIndex();
    expect(r.state).toBe('ok');
    expect(r.skipped).toBe(2);
    expect(r.index!.runs.map((x) => [x.id, x.trimmed, x.approvals])).toEqual([
      ['2-1', false, []],
      ['3-1', true, []],
    ]);
  });
});

describe('ResultsBranchReader の 1 回分の結果', () => {
  it('readRecord は未知の項目を残し、無ければ missing・形式違い・id 違いは broken', async () => {
    const { reader } = setup(
      {
        c1: {
          'index.json': index([entry('1-1'), entry('2-1'), entry('3-1')]),
          'runs/1-1/run.json': JSON.stringify(runJson('1-1')),
          'runs/1-1/traces/DD-A-B-T001.json': '{}',
          'runs/2-1/run.json': JSON.stringify(runJson('9-1')),
          'runs/3-1/run.json': JSON.stringify({ id: '3-1' }),
        },
      },
      { sha: 'c1' },
    );
    await reader.readIndex();
    const ok = await reader.readRecord('1-1');
    expect(ok.state).toBe('ok');
    expect(ok.record).toMatchObject({ id: '1-1', source: 'actions', futureField: 1, log: [], warnings: [], request: {} });
    expect((await reader.readRecord('2-1')).state).toBe('broken');
    expect((await reader.readRecord('3-1')).state).toBe('broken');
    expect((await reader.readRecord('4-1')).state).toBe('missing');
    expect(await reader.runFiles('1-1')).toEqual(['run.json', 'traces/DD-A-B-T001.json']);
    expect(await reader.readRecords(['1-1', '2-1', '4-1'])).toHaveLength(1);
    expect(new TextDecoder().decode(await reader.readFile('1-1', 'traces/DD-A-B-T001.json'))).toBe('{}');
  });
});
