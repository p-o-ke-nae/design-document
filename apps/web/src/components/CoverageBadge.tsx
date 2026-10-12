import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../backend/index.ts';
import type { CoverageCount, DocCoverage } from '../api.ts';
import { coverageText } from '../coverage.ts';
import { useApp } from '../state.tsx';

const Ctx = createContext<DocCoverage | null>(null);

export function useCoverage(): DocCoverage | null {
  return useContext(Ctx);
}

/** Loads `/api/coverage` for the open document; refetched when docs change or a run finishes. */
export function CoverageProvider({ path, children }: { path: string; children: ReactNode }) {
  const { version, latest } = useApp();
  const [cov, setCov] = useState<DocCoverage | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .coverage(path)
      .then((c) => alive && setCov(c))
      .catch(() => alive && setCov(null));
    return () => {
      alive = false;
    };
  }, [path, version, latest]);
  return <Ctx.Provider value={cov?.path === path ? cov : null}>{children}</Ctx.Provider>;
}

function Badge({ count, testId, label }: { count?: CoverageCount; testId: string; label: string }) {
  if (!count?.ids) return null;
  return (
    <span className="coverage-badge" data-testid={testId} title={label}>
      {coverageText(count)}
    </span>
  );
}

export function DocCoverageBadge() {
  const cov = useCoverage();
  return <Badge count={cov?.total} testId="coverage-doc" label="文書のカバレッジ" />;
}

export function DiagramCoverageBadge({ diagramId }: { diagramId: string }) {
  const cov = useCoverage();
  return <Badge count={cov?.diagrams[diagramId]} testId="coverage-diagram" label="図のカバレッジ" />;
}
