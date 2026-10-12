import { describe, expect, it } from 'vitest';
import { coverageReducer, coverageText, initialCoverageMode } from './coverage.ts';

describe('coverage view mode', () => {
  it('[DD-HIST-COVVIEW-T001] starts in highlight mode', () => {
    expect(initialCoverageMode).toBe('highlight');
  });

  it('[DD-HIST-COVVIEW-T002] showing coverage switches from highlight to coverage', () => {
    expect(coverageReducer('highlight', 'show')).toBe('coverage');
  });

  it('[DD-HIST-COVVIEW-T003] hiding coverage returns to highlight', () => {
    expect(coverageReducer('coverage', 'hide')).toBe('highlight');
  });

  it('[DD-HIST-COVVIEW-T004] selecting a row turns coverage off before highlighting', () => {
    expect(coverageReducer('coverage', 'select')).toBe('highlight');
  });

  it('[DD-HIST-COVVIEW-X001] hiding coverage in highlight mode changes nothing', () => {
    expect(coverageReducer('highlight', 'hide')).toBe('highlight');
  });

  it('[DD-HIST-COVVIEW-X002] selecting a row in highlight mode stays in highlight', () => {
    expect(coverageReducer('highlight', 'select')).toBe('highlight');
  });

  it('[DD-HIST-COVVIEW-X003] showing coverage again in coverage mode changes nothing', () => {
    expect(coverageReducer('coverage', 'show')).toBe('coverage');
  });

  it('formats the coverage line with floored percentages', () => {
    expect(coverageText({ ids: 3, linked: 2, executed: 1, passed: 1 })).toBe('テストID 3・紐づけ 2（66%）・実行 1（33%）・成功 1（33%）');
  });
});
