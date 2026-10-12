import { GitHubError, type GitHubClient } from '@ddv/github';
import { ReviewError } from './errors.ts';
import type { RepoReader } from './repo-reader.ts';

export interface StatusEdit {
  text: string;
  changed: boolean;
  warning?: string;
  /** 1-based file line that was replaced (status line) or that the new line is inserted before (closing `---`). */
  line?: number;
  /** Replacement for `line` as a suggestion (may span two lines when inserting). */
  suggestion?: string;
}

const STATUS_LINE = /^(status[ \t]*:[ \t]*)(?:"([^"]*)"|'([^']*)'|([^#\s][^#]*?)|)([ \t]*(?:#.*)?)$/;

/** REVCMT SETST: rewrites only the `status:` line of the front matter (comments, key order, quotes and EOL stay). */
export function setStatus(text: string, value = 'approved'): StatusEdit {
  const raws = text.split(/(?<=\n)/);
  const body = (raw: string) => raw.replace(/\r?\n$/, '');
  const noFm: StatusEdit = { text, changed: false, warning: '先頭に front matter（---）がありません' };
  if (!raws.length || body(raws[0]) !== '---') return noFm;
  const close = raws.findIndex((r, i) => i > 0 && body(r) === '---');
  if (close < 0) return noFm;
  const eol = raws[0].slice(body(raws[0]).length) || '\n';
  for (let i = 1; i < close; i++) {
    const content = body(raws[i]);
    if (!/^status[ \t]*:/.test(content)) continue;
    const m = STATUS_LINE.exec(content);
    if (!m) return { text, changed: false, warning: 'status の行を解釈できません' };
    const current = m[2] ?? m[3] ?? m[4] ?? '';
    if (current === value) return { text, changed: false, line: i + 1 };
    const quote = m[2] !== undefined ? '"' : m[3] !== undefined ? "'" : '';
    const next = `${m[1]}${quote}${value}${quote}${m[5]}`;
    const out = [...raws];
    out[i] = next + raws[i].slice(content.length);
    return { text: out.join(''), changed: true, line: i + 1, suggestion: next };
  }
  const out = [...raws];
  out.splice(close, 0, `status: ${value}${eol}`);
  return { text: out.join(''), changed: true, line: close + 1, suggestion: `status: ${value}${eol.replace('\r', '')}---` };
}

/** The part of a workspace StatusCommitter needs. */
export interface CommitTarget {
  headSha: string;
  head: RepoReader;
  pr?: { headRepo: string; headRef: string } | null;
}

export interface StatusCommit {
  sha: string;
  paths: string[];
}

const encodeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/**
 * REVCMT status 連動: one commit on the PR head branch through the Git Data API
 * (ref check → blobs → tree → commit → non-force PATCH). Returns null when nothing needs to change.
 * A moved head (or a non-fast-forward PATCH) aborts with a `stale` ReviewError.
 */
export class StatusCommitter {
  constructor(private readonly github: GitHubClient) {}

  async commit(ws: CommitTarget, paths: string[], value = 'approved'): Promise<StatusCommit | null> {
    if (!ws.pr?.headRepo || !ws.pr.headRef) throw new ReviewError(409, 'not-pr', 'PR の head ブランチを特定できません');
    const repo = `/repos/${ws.pr.headRepo}`;
    const ref = encodeRef(ws.pr.headRef);
    const stale = () => new ReviewError(409, 'stale', 'PR の head が進んでいます。最新化してからやり直してください');

    const edits: { path: string; text: string }[] = [];
    for (const p of paths) {
      const text = await ws.head.readText(p);
      const r = setStatus(text, value);
      if (r.changed) edits.push({ path: p, text: r.text });
    }
    if (!edits.length) return null;

    const cur = await this.github.rest<{ object: { sha: string } }>('GET', `${repo}/git/ref/heads/${ref}`);
    if (cur.object.sha !== ws.headSha) throw stale();
    const tree: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
    for (const e of edits) {
      const blob = await this.github.rest<{ sha: string }>('POST', `${repo}/git/blobs`, { content: e.text, encoding: 'utf-8' });
      tree.push({ path: e.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const head = await this.github.rest<{ tree: { sha: string } }>('GET', `${repo}/git/commits/${ws.headSha}`);
    const newTree = await this.github.rest<{ sha: string }>('POST', `${repo}/git/trees`, { base_tree: head.tree.sha, tree });
    const commit = await this.github.rest<{ sha: string }>('POST', `${repo}/git/commits`, {
      message: `docs: approve ${edits.map((e) => e.path.split('/').pop()).join(' ')} (ddv)`,
      tree: newTree.sha,
      parents: [ws.headSha],
    });
    try {
      await this.github.rest('PATCH', `${repo}/git/refs/heads/${ref}`, { sha: commit.sha, force: false });
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'validation') throw stale();
      throw e;
    }
    return { sha: commit.sha, paths: edits.map((e) => e.path) };
  }
}
