/** Lock-file warning of the Pages edition (pages-viewer.md「ロックの警告」). */
import type { DdvConfig, DocEntry } from '@ddv/core';
import { docMatrices, emptyLock, type TestIdLock } from '@ddv/testid/core';

export type LockStatus = 'present' | 'missing' | 'unreadable';

export interface LockWarning {
  status: LockStatus;
  /** Doc path → `lock-warning` text (only docs with at least one diagram that has provisional cases). */
  byDoc: Map<string, string>;
}

const HEAD: Record<LockStatus, string> = {
  present: 'テストIDのロックが図より古い（ddv-testid generate が未実行）',
  missing: 'テストIDのロックがありません（ddv-testid generate が未実行）',
  unreadable: 'テストIDのロックを読めません（.ddv/testids.lock.json）',
};

function parse(lockText: string | null): { status: LockStatus; lock: TestIdLock } {
  if (lockText === null) return { status: 'missing', lock: emptyLock() };
  try {
    const v = JSON.parse(lockText) as TestIdLock;
    if (!v || typeof v !== 'object' || typeof v.diagrams !== 'object' || v.diagrams === null) throw new Error('shape');
    return { status: 'present', lock: v };
  } catch {
    return { status: 'unreadable', lock: emptyLock() };
  }
}

export function checkLock(docs: DocEntry[], config: DdvConfig, lockText: string | null): LockWarning {
  const { status, lock } = parse(lockText);
  const byDoc = new Map<string, string>();
  for (const doc of docs) {
    const parts: string[] = [];
    for (const m of docMatrices(doc, config, structuredClone(lock))) {
      const n = m.cases.filter((c) => c.provisional).length;
      if (n > 0) parts.push(`${m.diagram} に新しい経路が ${n} 件あります（仮IDで表示）`);
    }
    if (parts.length) byDoc.set(doc.path, `${HEAD[status]}：${parts.join('、')}`);
  }
  return { status, byDoc };
}
