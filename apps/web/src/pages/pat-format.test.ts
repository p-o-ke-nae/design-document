import { describe, expect, it } from 'vitest';
import { PAT_FORMAT_MESSAGES, PatFormatError, parsePat } from './pat-format.ts';

const ng = (raw: string) => {
  const r = parsePat(raw);
  if (r.ok) throw new Error('expected NG');
  expect(r.error).toBeInstanceOf(PatFormatError);
  expect(r.error.message).toBe(PAT_FORMAT_MESSAGES[r.error.code]);
  return r.error;
};

const classic = 'ghp_' + 'A1b2'.repeat(9); // 40 文字
const fine = 'github_pat_' + 'x'.repeat(29); // 40 文字

describe('parsePat (DD-PAT-PATFMT)', () => {
  it('[DD-PAT-PATFMT-P001] [DD-PAT-PATFMT-T001] [DD-PAT-PATFMT-T002] [DD-PAT-PATFMT-T003] 空白・改行・ゼロ幅文字だけなら empty', () => {
    expect(ng('').code).toBe('empty');
    expect(ng(' \n\t\u200B\u200C\u200D\uFEFF ').code).toBe('empty');
    expect(PAT_FORMAT_MESSAGES.empty).toBe('PAT を入力してください');
  });

  it('[DD-PAT-PATFMT-P002] [DD-PAT-PATFMT-T004] [DD-PAT-PATFMT-T005] 英数字と _ 以外を含むと chars（文言に入力値を含めない）', () => {
    const e = ng('ghp_abc-def' + 'x'.repeat(40));
    expect(e.code).toBe('chars');
    expect(e.message).toBe('PAT に使えない文字が含まれています（貼り付けた内容を確認してください）');
    expect(e.message).not.toContain('abc');
    expect(ng('Bearer:' + classic).code).toBe('chars');
  });

  it('[DD-PAT-PATFMT-P003] [DD-PAT-PATFMT-T006] [DD-PAT-PATFMT-T007] [DD-PAT-PATFMT-T008] ghp_ で 40 文字以上は classic。除いた後の値を token にする', () => {
    expect(parsePat(classic)).toEqual({ ok: true, token: classic, kind: 'classic' });
    const pasted = ` ${classic.slice(0, 10)}\u200B${classic.slice(10)}\r\n`;
    expect(parsePat(pasted)).toEqual({ ok: true, token: classic, kind: 'classic' });
    expect(parsePat(classic + 'zzzz')).toMatchObject({ ok: true, kind: 'classic' });
  });

  it('[DD-PAT-PATFMT-P004] [DD-PAT-PATFMT-T007] [DD-PAT-PATFMT-T009] ghp_ で 40 文字未満は short', () => {
    const e = ng(classic.slice(0, 39));
    expect(e.code).toBe('short');
    expect(e.message).toBe('PAT が短すぎます（途中までしか貼り付けられていない可能性があります）');
  });

  it('[DD-PAT-PATFMT-P005] [DD-PAT-PATFMT-T010] [DD-PAT-PATFMT-T011] [DD-PAT-PATFMT-T012] github_pat_ で 40 文字以上は fineGrained', () => {
    expect(parsePat(fine)).toEqual({ ok: true, token: fine, kind: 'fineGrained' });
    expect(parsePat(`\t${fine}\n`)).toEqual({ ok: true, token: fine, kind: 'fineGrained' });
  });

  it('[DD-PAT-PATFMT-P006] [DD-PAT-PATFMT-T011] [DD-PAT-PATFMT-T013] github_pat_ で 40 文字未満は short', () => {
    expect(ng(fine.slice(0, 39)).code).toBe('short');
    expect(ng('github_pat_').code).toBe('short');
  });

  it('[DD-PAT-PATFMT-P007] [DD-PAT-PATFMT-T014] [DD-PAT-PATFMT-T015] gho_ ghu_ ghs_ ghr_ は notPat', () => {
    for (const p of ['gho_', 'ghu_', 'ghs_', 'ghr_']) {
      const e = ng(p + 'x'.repeat(36));
      expect(e.code).toBe('notPat');
      expect(e.message).toBe('OAuth・GitHub App のトークンは使えません。ghp_ または github_pat_ で始まる PAT を入力してください');
    }
  });

  it('[DD-PAT-PATFMT-P008] [DD-PAT-PATFMT-T014] [DD-PAT-PATFMT-T016] 他の接頭辞は prefix（モックと同じ文言）', () => {
    for (const raw of ['x'.repeat(40), 'ghx_' + 'x'.repeat(36), 'GHP_' + 'x'.repeat(36)]) {
      const e = ng(raw);
      expect(e.code).toBe('prefix');
      expect(e.message).toBe('ghp_ または github_pat_ で始まる PAT を入力してください');
    }
  });
});
