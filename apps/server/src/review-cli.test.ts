import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient, TokenResolver } from '@ddv/github';
import { createContext } from './app.ts';
import { GitCache } from './git.ts';
import { createUpstream, fakeGitHub, fakeGitHubState } from './github-fixture.ts';
import { extractSuggestion, formatReviewText, parseReviewArgs, ReviewCliError, reviewComments, type ReviewOutput } from './review-cli.ts';
import { WorkspaceManager } from './workspaces.ts';

const DOC = `---
id: ORDER
kind: basic
status: review
title: 注文 基本設計
---

# 注文

## 画面遷移

\`\`\`mermaid id=flow code=SCREEN matrix nswitch=0
flowchart TD
  A[入力] --> B[確認]
  B --> C[完了]
\`\`\`

## 補足

説明。
`;
const lineOf = (s: string) => DOC.split('\n').findIndex((l) => l.includes(s)) + 1;
const P = 'docs/design/basic/order.md';

describe('extractSuggestion', () => {
  it('先頭コメントの suggestion ブロックの中身を返す（無ければ null）', () => {
    expect(extractSuggestion('直して\n```suggestion\n新しい行\n2行目\n```\n')).toBe('新しい行\n2行目');
    expect(extractSuggestion('```suggestion\n```')).toBe('');
    expect(extractSuggestion('ただの指摘')).toBeNull();
    expect(extractSuggestion(undefined)).toBeNull();
  });
});

describe('parseReviewArgs', () => {
  it('--github と --pr が必須、--json / --all は任意', () => {
    expect(parseReviewArgs(['--github', 'o/r', '--pr', '12', '--json', '--all'])).toEqual({ repo: 'o/r', pr: 12, json: true, all: true });
    expect(parseReviewArgs(['--github', 'o/r', '--pr', '12'])).toMatchObject({ json: false, all: false });
    expect(() => parseReviewArgs(['--github', 'o/r'])).toThrow(ReviewCliError);
  });
});

describe('formatReviewText', () => {
  it('文書・見出しごとにまとめる', () => {
    const t = (id: string, heading: string | null, line: number) => ({
      id,
      url: `https://github.com/o/r/pull/1#${id}`,
      resolved: false,
      outdated: false,
      path: P,
      line,
      startLine: null,
      doc: { id: 'ORDER', status: 'review', heading },
      element: null,
      testIds: ['BD-ORDER-SCREEN-P001'],
      suggestion: '新',
      comments: [{ id: 1, author: 'bob', body: '指摘', createdAt: '' }],
    });
    const out: ReviewOutput = { pr: 1, headSha: 'abcdef012345', threads: [t('a', '画面遷移', 5), t('b', '画面遷移', 6), t('c', null, 1)] };
    const text = formatReviewText(out);
    expect(text).toContain(`■ ${P}（ORDER, status: review）`);
    expect(text.match(/## 画面遷移/g)).toHaveLength(1);
    expect(text).toContain('## （文書全体・見出し外）');
    expect(text).toContain('テストID: BD-ORDER-SCREEN-P001');
    expect(text).toContain('@bob: 指摘');
  });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

describe('reviewComments', () => {
  it('ワークスペースを取得し、未解決スレッドを文書・見出し・要素・テストID付きで返す', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-rc-'));
    dirs.push(tmp);
    const up = await createUpstream(path.join(tmp, 'up'));
    const feat = up.commit('feature/x', { [P]: DOC });
    up.setPull(12, feat);
    const state = fakeGitHubState({
      pulls: { 'acme/order-app': [{ number: 12, title: '注文', headSha: feat, headRef: 'feature/x', baseRef: 'main' }] },
      refs: { 'acme/order-app': { main: up.git('rev-parse', 'main'), 'feature/x': feat } },
      threads: {
        'acme/order-app#12': [
          { id: 'T1', path: P, line: lineOf('B --> C'), comments: [{ id: 1, author: 'bob', body: '```suggestion\n  B --> D[中止]\n```' }] },
          { id: 'T2', path: P, line: lineOf('説明。'), resolved: true, comments: [{ id: 2, author: 'bob', body: '済' }] },
          { id: 'T3', path: P, line: null, comments: [{ id: 3, author: 'bob', body: '全体' }] },
        ],
      },
    });
    const f = fakeGitHub(state);
    const tokens = new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: state.token }, fetch: f });
    const github = new GitHubClient(tokens, { fetch: f });
    const git = new GitCache(path.join(tmp, 'home'), tokens, { remoteUrl: (o, r) => path.join(tmp, 'up', o, r) });
    const manager = new WorkspaceManager({ home: path.join(tmp, 'home'), github, git, createContext: (dir) => createContext(dir, { watch: false }), pollSeconds: 0 });
    try {
      const out = await reviewComments(manager, { repo: 'acme/order-app', pr: 12, json: true, all: false });
      expect(out.pr).toBe(12);
      expect(out.headSha).toBe(feat);
      expect(out.threads.map((t) => t.id)).toEqual(['T1', 'T3']);
      const t1 = out.threads[0];
      expect(t1.doc).toEqual({ id: 'ORDER', status: 'review', heading: '画面遷移' });
      expect(t1.element).toMatchObject({ kind: 'edge', key: 'flow#edge:B||C' });
      expect(t1.testIds.length).toBeGreaterThan(0);
      expect(t1.testIds.every((id) => /^BD-ORDER-SCREEN-P\d{3}$/.test(id))).toBe(true);
      expect(t1.suggestion).toBe('  B --> D[中止]');
      expect(out.threads[1]).toMatchObject({ element: null, testIds: [], suggestion: null });

      const all = await reviewComments(manager, { repo: 'acme/order-app', pr: 12, json: true, all: true });
      expect(all.threads.map((t) => t.id)).toEqual(['T1', 'T3', 'T2']);
      expect(all.threads[2]).toMatchObject({ resolved: true, doc: { heading: '補足' } });
    } finally {
      manager.dispose();
    }
  });

  it('PR が無ければ ReviewCliError', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ddv-rc-'));
    dirs.push(tmp);
    await createUpstream(path.join(tmp, 'up'));
    const state = fakeGitHubState();
    const f = fakeGitHub(state);
    const tokens = new TokenResolver({ runGh: async () => null, env: { GITHUB_TOKEN: state.token }, fetch: f });
    const github = new GitHubClient(tokens, { fetch: f });
    const git = new GitCache(path.join(tmp, 'home'), tokens, { remoteUrl: (o, r) => path.join(tmp, 'up', o, r) });
    const manager = new WorkspaceManager({ home: path.join(tmp, 'home'), github, git, createContext: (dir) => createContext(dir, { watch: false }), pollSeconds: 0 });
    try {
      await expect(reviewComments(manager, { repo: 'acme/order-app', pr: 99, json: true, all: false })).rejects.toThrow(ReviewCliError);
    } finally {
      manager.dispose();
    }
  });
});
