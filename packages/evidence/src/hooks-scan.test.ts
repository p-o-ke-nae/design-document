import { describe, expect, it } from 'vitest';
import { HOOKS_UNREADABLE, scanEvidenceHooks } from './hooks-scan.ts';

const scan = (body: string) => scanEvidenceHooks(`import { defineEvidence } from '@ddv/evidence';\n${body}\n`, 'e2e/ddv-hooks.ts');

describe('hooks の静的な読み取り（HOOKSCAN）', () => {
  it('[DD-EVSPEC-HOOKSCAN-P001] [DD-EVSPEC-HOOKSCAN-T001] [DD-EVSPEC-HOOKSCAN-T002] export const evidence が無ければ found=false', () => {
    expect(scan('export const hooks = {};\nconst evidence = { a: 1 };')).toEqual({ found: false, readable: false, providers: [], warnings: [] });
  });

  it('[DD-EVSPEC-HOOKSCAN-P002] [DD-EVSPEC-HOOKSCAN-T003] [DD-EVSPEC-HOOKSCAN-T004] 初期値がオブジェクトのリテラルでなければ読めない', () => {
    expect(scan('const all = {};\nexport const evidence = all;')).toEqual({ found: true, readable: false, providers: [], warnings: [HOOKS_UNREADABLE] });
    expect(scan('export const evidence = makeEvidence();').readable).toBe(false);
  });

  it('[DD-EVSPEC-HOOKSCAN-P003] [DD-EVSPEC-HOOKSCAN-T005] [DD-EVSPEC-HOOKSCAN-T006] [DD-EVSPEC-HOOKSCAN-T007] 名前を読めないプロパティは警告', () => {
    const r = scan("const k = 'x';\nconst more = {};\nexport const evidence = {\n  [k]: defineEvidence({ run: async () => [] }),\n  ...more,\n  ok: defineEvidence({ run: async () => [] }),\n};");
    expect(r.warnings).toEqual(['hooks の evidence に名前を読めないプロパティがあります（5 行目）', 'hooks の evidence に名前を読めないプロパティがあります（6 行目）']);
    expect(r.providers.map((p) => p.name)).toEqual(['ok']);
  });

  it('[DD-EVSPEC-HOOKSCAN-P004] [DD-EVSPEC-HOOKSCAN-T008] [DD-EVSPEC-HOOKSCAN-T009] defineEvidence（リテラル）でなければ名前だけ', () => {
    const r = scan("const def = defineEvidence({ run: async () => [] });\nexport const evidence = { 'mail-log': def, def, other: wrap({ params: { a: {} } }), m() { return []; } };");
    expect(r.providers).toEqual(
      ['mail-log', 'def', 'other', 'm'].map((name) => ({ name, kind: 'hooks', params: {}, paramsKnown: false, source: 'e2e/ddv-hooks.ts' })),
    );
  });

  it('[DD-EVSPEC-HOOKSCAN-P005] [DD-EVSPEC-HOOKSCAN-T010] [DD-EVSPEC-HOOKSCAN-T011] params がリテラルでなければ名前だけ', () => {
    const r = scan('const p = { a: {} };\nexport const evidence = { x: defineEvidence({ params: p, run: async () => [] }), y: defineEvidence({ run: async () => [] }) };');
    expect(r.providers.map((p) => [p.name, p.paramsKnown])).toEqual([
      ['x', false],
      ['y', false],
    ]);
  });

  it('[DD-EVSPEC-HOOKSCAN-P006] [DD-EVSPEC-HOOKSCAN-T012] params がリテラルなら名前と params を登録', () => {
    const r = scan(`export const evidence = {
  'mail-log': defineEvidence({
    params: { since: { required: true }, limit: { default: 10 }, all: { required: true, default: false }, x: {} },
    timeout: 5_000,
    async run(ctx, args) { return []; },
  }),
} satisfies Record<string, unknown>;`);
    expect(r).toEqual({
      found: true,
      readable: true,
      warnings: [],
      providers: [
        {
          name: 'mail-log',
          kind: 'hooks',
          params: { since: { required: true }, limit: { required: false, default: 10 }, all: { required: true, default: false }, x: { required: false } },
          paramsKnown: true,
          timeout: 5000,
          source: 'e2e/ddv-hooks.ts',
        },
      ],
    });
  });
});
