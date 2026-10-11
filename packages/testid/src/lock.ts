import type { CaseKind, TestCase } from '@ddv/graph';

export interface LockCase {
  id: string;
  status: 'active' | 'retired';
  title: string;
}

export interface LockDiagram {
  doc: string;
  diagram: string;
  next: Partial<Record<CaseKind, number>>;
  cases: Record<string, LockCase>;
}

export interface TestIdLock {
  version: 1;
  diagrams: Record<string, LockDiagram>;
}

export const LOCK_PATH = '.ddv/testids.lock.json';

export function emptyLock(): TestIdLock {
  return { version: 1, diagrams: {} };
}

export function sanitizeCode(s: string): string {
  return s
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function formatId(diagramKey: string, kind: CaseKind, n: number): string {
  return `${diagramKey}-${kind}${String(n).padStart(3, '0')}`;
}

/** Regex matching ids produced by `formatId` for the given prefixes. */
export function idPattern(prefixes: string[]): RegExp {
  const p = prefixes.map((x) => x.replace(/[^A-Za-z0-9]/g, '')).join('|');
  return new RegExp(`\\b(?:${p})(?:-[A-Z0-9]+)+-[PTSX]\\d{3}\\b`, 'g');
}

export interface AssignedCase extends TestCase {
  id: string;
  /** true when the id is not yet persisted in the lock file */
  provisional: boolean;
}

export interface AssignResult {
  cases: AssignedCase[];
  retired: Array<{ signature: string; id: string }>;
  changed: boolean;
}

/**
 * Assigns stable ids. Existing signatures keep their id (retired ones are revived),
 * new signatures get the next number per kind, signatures that disappeared are retired.
 * Mutates `entry`.
 */
export function assignIds(entry: LockDiagram, diagramKey: string, cases: TestCase[]): AssignResult {
  let changed = false;
  const seen = new Set<string>();
  const assigned: AssignedCase[] = cases.map((c) => {
    seen.add(c.signature);
    const existing = entry.cases[c.signature];
    if (existing) {
      if (existing.status !== 'active' || existing.title !== c.title) {
        existing.status = 'active';
        existing.title = c.title;
        changed = true;
      }
      return { ...c, id: existing.id, provisional: false };
    }
    const n = entry.next[c.kind] ?? 1;
    entry.next[c.kind] = n + 1;
    const id = formatId(diagramKey, c.kind, n);
    entry.cases[c.signature] = { id, status: 'active', title: c.title };
    changed = true;
    return { ...c, id, provisional: true };
  });
  const retired: AssignResult['retired'] = [];
  for (const [sig, lc] of Object.entries(entry.cases)) {
    if (!seen.has(sig) && lc.status === 'active') {
      lc.status = 'retired';
      retired.push({ signature: sig, id: lc.id });
      changed = true;
    }
  }
  return { cases: assigned, retired, changed };
}
