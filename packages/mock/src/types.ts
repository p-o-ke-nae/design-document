// Browser-safe shared types (no runtime imports).

export type Value = string | number | boolean;

export interface Expect {
  screen: string;
  visible?: string[];
  hidden?: string[];
  text?: Record<string, string>;
  count?: Record<string, number>;
}

export interface Step {
  event: string;
  input?: Record<string, Value>;
  click?: string;
  do?: string;
  wait?: number;
  expect: Expect;
}

export interface Scenario {
  id: string;
  title: string;
  fixtures: string[];
  start: string;
  steps: Step[];
}

export type FieldKind = 'text' | 'number' | 'select' | 'checkbox';

export interface PathTransition {
  from: string;
  to: string;
  event: string;
  guard: string;
  /** Edge index in the diagram (GraphEdge.index), for highlighting. */
  edge: number;
}

export interface PathSpec {
  id: string;
  title: string;
  start: string;
  transitions: PathTransition[];
  /** All edge indices of the path including pseudo start/end edges. */
  edges: number[];
}
