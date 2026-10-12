import { describe, expect, it } from 'vitest';
import { docEntryOf, parseConfig } from '@ddv/core';
import { formatLock, generateFrom, emptyLock } from '@ddv/testid/core';
import { checkLock } from './lock-check.ts';

const config = parseConfig({});
const doc = (flow: string) =>
  docEntryOf('docs/design/detailed/a.md', `---\nkind: detailed\nid: A\n---\n# A\n\n\`\`\`mermaid id=f code=F matrix\nflowchart TD\n${flow}\n\`\`\`\n`);
const plain = docEntryOf('docs/design/detailed/b.md', '# B\n\n本文\n');

describe('checkLock', () => {
  it('ロックが図と合っていれば警告しない・ロックを書き換えない', () => {
    const d = doc('  A --> B\n  A --> C');
    const lock = formatLock(generateFrom([d], config, emptyLock()).lock);
    const r = checkLock([d, plain], config, lock);
    expect(r.status).toBe('present');
    expect(r.byDoc.size).toBe(0);
    expect(checkLock([d], config, lock).byDoc.size).toBe(0);
  });

  it('ロックに無い経路があれば図ごとの件数を出す', () => {
    const lock = formatLock(generateFrom([doc('  A --> B')], config, emptyLock()).lock);
    const r = checkLock([doc('  A --> B\n  A --> C\n  A --> D'), plain], config, lock);
    expect(r.byDoc.get('docs/design/detailed/a.md')).toMatch(/^テストIDのロックが図より古い（ddv-testid generate が未実行）：f に新しい経路が \d+ 件あります（仮IDで表示）$/);
    expect(r.byDoc.has('docs/design/detailed/b.md')).toBe(false);
  });

  it('ロックが無い・読めないときは空のロックとして判定する', () => {
    const d = doc('  A --> B');
    expect(checkLock([d], config, null).byDoc.get(d.path)).toMatch(/^テストIDのロックがありません（ddv-testid generate が未実行）：f に新しい経路が/);
    const bad = checkLock([d], config, 'not json');
    expect(bad.status).toBe('unreadable');
    expect(bad.byDoc.get(d.path)).toMatch(/^テストIDのロックを読めません（\.ddv\/testids\.lock\.json）：f に新しい経路が/);
  });
});
