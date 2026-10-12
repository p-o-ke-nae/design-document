/** PAT format check (pat.md「PAT の形式」, DD-PAT-PATFMT). Only lower bounds on length so that GitHub's format changes still pass. */

export type PatKind = 'classic' | 'fineGrained';

export type PatFormatCode = 'empty' | 'chars' | 'short' | 'notPat' | 'prefix';

export const PAT_FORMAT_MESSAGES: Record<PatFormatCode, string> = {
  empty: 'PAT を入力してください',
  chars: 'PAT に使えない文字が含まれています（貼り付けた内容を確認してください）',
  short: 'PAT が短すぎます（途中までしか貼り付けられていない可能性があります）',
  notPat: 'OAuth・GitHub App のトークンは使えません。ghp_ または github_pat_ で始まる PAT を入力してください',
  prefix: 'ghp_ または github_pat_ で始まる PAT を入力してください',
};

/** The message never contains the input (no part of the PAT). */
export class PatFormatError extends Error {
  constructor(readonly code: PatFormatCode) {
    super(PAT_FORMAT_MESSAGES[code]);
    this.name = 'PatFormatError';
  }
}

export type ParsePatResult = { ok: true; token: string; kind: PatKind } | { ok: false; error: PatFormatError };

const MIN_LENGTH = 40;
const IGNORED = /[\s\u200B-\u200D\uFEFF]/g;

export function parsePat(raw: string): ParsePatResult {
  const token = raw.replace(IGNORED, '');
  const ng = (code: PatFormatCode): ParsePatResult => ({ ok: false, error: new PatFormatError(code) });
  if (!token) return ng('empty');
  if (!/^[A-Za-z0-9_]+$/.test(token)) return ng('chars');
  if (token.startsWith('ghp_')) return token.length >= MIN_LENGTH ? { ok: true, token, kind: 'classic' } : ng('short');
  if (token.startsWith('github_pat_')) return token.length >= MIN_LENGTH ? { ok: true, token, kind: 'fineGrained' } : ng('short');
  if (/^gh[ousr]_/.test(token)) return ng('notPat');
  return ng('prefix');
}
