/** Diagram colour mode: path highlight or design coverage (never both at once). */
export type CoverageMode = 'highlight' | 'coverage';
export type CoverageEvent = 'show' | 'hide' | 'select';

export const initialCoverageMode: CoverageMode = 'highlight';

export function coverageReducer(mode: CoverageMode, ev: CoverageEvent): CoverageMode {
  if (mode === 'highlight') return ev === 'show' ? 'coverage' : mode;
  return ev === 'hide' || ev === 'select' ? 'highlight' : mode;
}

export function coveragePct(n: number, ids: number): number {
  return ids ? Math.floor((n / ids) * 100) : 0;
}

export function coverageText(c: { ids: number; linked: number; executed: number; passed: number }): string {
  return `テストID ${c.ids}・紐づけ ${c.linked}（${coveragePct(c.linked, c.ids)}%）・実行 ${c.executed}（${coveragePct(c.executed, c.ids)}%）・成功 ${c.passed}（${coveragePct(c.passed, c.ids)}%）`;
}
