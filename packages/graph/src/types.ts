export type DiagramKind = 'state' | 'flowchart';

export interface GraphNode {
  id: string;
  label: string;
  /** start / end pseudo states ([*]) or choice nodes */
  role: 'normal' | 'start' | 'end' | 'choice';
  /** Line in the diagram code (1-based) where the node is defined, or first appears. */
  line?: number;
}

export interface GraphEdge {
  /** Index in source order. Mermaid renders edges in this order. */
  index: number;
  from: string;
  to: string;
  /** Raw label text (as written after ":" or inside |...|). */
  label: string;
  event: string;
  guard: string;
  action: string;
  /** Unique, stable key inside a diagram: from|label|to (+#n for duplicates). */
  key: string;
  /** Line in the diagram code (1-based). */
  line?: number;
}

export interface Graph {
  kind: DiagramKind;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
  /** `%% req: <elementKey> REQ-001` annotations: element key -> requirement ids */
  annotations: Record<string, string[]>;
}

export interface MatrixOptions {
  /** N for N-switch coverage (0 disables, 1 = transition pairs). */
  nSwitch: number;
  /** How many extra times a node may be revisited in a simple path. */
  loopLimit: number;
  /** Upper bound of generated paths; excess is reported as a warning. */
  maxPaths: number;
}

export type CaseKind = 'P' | 'T' | 'S' | 'X';

export interface TestCase {
  kind: CaseKind;
  /** Stable signature used as key in the test id lock file. */
  signature: string;
  /** Human readable summary. */
  title: string;
  /** Edge indices to highlight, in execution order (includes the prefix path). */
  edges: number[];
  /** Node ids in execution order. */
  nodes: string[];
  /** For X (invalid transition): state and event. */
  state?: string;
  event?: string;
  expected: string;
}

export interface StateEventTable {
  states: string[];
  events: string[];
  /** cells[state][event] = target node ids (empty array = invalid transition) */
  cells: Record<string, Record<string, string[]>>;
}

export interface MatrixResult {
  cases: TestCase[];
  table?: StateEventTable;
  warnings: string[];
}
