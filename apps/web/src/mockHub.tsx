import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './backend/index.ts';
import type { ScenarioSummary, TdScenario } from './api.ts';
import type { DraftData, PlayerFailure } from './player.ts';

/** Edges/nodes to emphasise on a diagram of the current doc while a mock scenario plays. */
export interface PlayHighlight {
  edges: number[];
  nodes: string[];
  scenarioId: string;
  caption: string;
}

/** Doc-level coordination between MockFrame (player), DiagramBlock (highlight) and MatrixPanel (▶ モック). */
export interface MockHub {
  scenarios: ScenarioSummary[];
  refreshScenarios(): void;
  mocks: string[];
  registerMock(target: string): () => void;
  highlights: Record<string, PlayHighlight>;
  setHighlight(diagram: string, h: PlayHighlight | null): void;
  playRequest: { id: string; seq: number } | null;
  requestPlay(id: string): void;
  /** Whether a mock shown in this doc has a playable scenario with the test ID. */
  hasScenario(id: string): boolean;
  /** Test data editor panel (DD-TDEDIT): the scenario shown, or null when closed. */
  testData: { id: string; seq: number } | null;
  /** Opens the editor (asks the open editor first when it has unsaved changes). */
  openTestData(id: string | null): void;
  /** The open editor registers whether leaving it needs confirmation (他へ移る). */
  setLeaveGuard(guard: (() => boolean) | null): void;
  /** Preview (編集中の再生) asked by the editor, handled by the MockFrame owning the scenario. */
  preview: PreviewRequest | null;
  startPreview(id: string, scenario: TdScenario, data: DraftData): number;
  previewResult: PreviewResult | null;
  endPreview(r: PreviewResult): void;
}

export interface PreviewRequest {
  id: string;
  scenario: TdScenario;
  data: DraftData;
  seq: number;
}

export interface PreviewResult {
  seq: number;
  ok: boolean;
  failure: PlayerFailure | null;
}

const Ctx = createContext<MockHub | null>(null);

export const useMockHub = () => useContext(Ctx);

export function scenarioBelongsTo(s: ScenarioSummary, target: string): boolean {
  const t = target.replace(/\\/g, '/').replace(/^\/+/, '');
  const dir = t.includes('/') ? t.slice(0, t.lastIndexOf('/')) : '';
  const mock = (s.mock ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (mock === t || (dir && mock === dir)) return true;
  return !!dir && `/${(s.file ?? '').replace(/\\/g, '/')}`.includes(`/${dir}/scenarios/`);
}

export function playableScenarios(all: ScenarioSummary[], target: string): ScenarioSummary[] {
  return all.filter((s) => s.status !== 'Retired' && scenarioBelongsTo(s, target));
}

export function MockHubProvider({ version, children }: { version: number; children: ReactNode }) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [mocks, setMocks] = useState<string[]>([]);
  const [highlights, setHighlights] = useState<Record<string, PlayHighlight>>({});
  const [playRequest, setPlayRequest] = useState<{ id: string; seq: number } | null>(null);

  const refreshScenarios = useCallback(() => {
    api
      .scenarios()
      .then((r) => setScenarios(Array.isArray(r.scenarios) ? r.scenarios : []))
      .catch(() => setScenarios([]));
  }, []);

  useEffect(() => refreshScenarios(), [refreshScenarios, version]);

  const registerMock = useCallback((target: string) => {
    setMocks((m) => [...m, target]);
    return () =>
      setMocks((m) => {
        const i = m.indexOf(target);
        return i < 0 ? m : [...m.slice(0, i), ...m.slice(i + 1)];
      });
  }, []);

  const setHighlight = useCallback((diagram: string, h: PlayHighlight | null) => {
    setHighlights((cur) => {
      if (!h) {
        if (!(diagram in cur)) return cur;
        const { [diagram]: _drop, ...rest } = cur;
        return rest;
      }
      const prev = cur[diagram];
      if (prev && prev.caption === h.caption && prev.edges.join() === h.edges.join() && prev.nodes.join() === h.nodes.join()) return cur;
      return { ...cur, [diagram]: h };
    });
  }, []);

  const requestPlay = useCallback((id: string) => setPlayRequest((r) => ({ id, seq: (r?.seq ?? 0) + 1 })), []);

  const [testData, setTestData] = useState<{ id: string; seq: number } | null>(null);
  const leaveGuard = useRef<(() => boolean) | null>(null);
  const setLeaveGuard = useCallback((g: (() => boolean) | null) => void (leaveGuard.current = g), []);
  const openTestData = useCallback((id: string | null) => {
    if (leaveGuard.current && !leaveGuard.current()) return;
    setTestData((t) => (id === null ? null : { id, seq: (t?.seq ?? 0) + 1 }));
  }, []);
  const [preview, setPreview] = useState<PreviewRequest | null>(null);
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const previewSeq = useRef(0);
  const startPreview = useCallback((id: string, scenario: TdScenario, data: DraftData) => {
    const seq = ++previewSeq.current;
    setPreview({ id, scenario, data, seq });
    return seq;
  }, []);
  const endPreview = useCallback((r: PreviewResult) => setPreviewResult((cur) => (cur?.seq === r.seq ? cur : r)), []);

  const playable = useMemo(() => new Set(mocks.flatMap((m) => playableScenarios(scenarios, m).map((s) => s.id))), [mocks, scenarios]);
  const hasScenario = useCallback((id: string) => playable.has(id), [playable]);

  const value = useMemo<MockHub>(
    () => ({ scenarios, refreshScenarios, mocks, registerMock, highlights, setHighlight, playRequest, requestPlay, hasScenario, testData, openTestData, setLeaveGuard, preview, startPreview, previewResult, endPreview }),
    [scenarios, refreshScenarios, mocks, registerMock, highlights, setHighlight, playRequest, requestPlay, hasScenario, testData, openTestData, setLeaveGuard, preview, startPreview, previewResult, endPreview],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
