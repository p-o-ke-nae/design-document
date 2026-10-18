// Browser-safe shared types (no runtime imports).
import type { EvidenceSpecInput } from '@ddv/evidence/spec';
import type { OnlyValue } from './platform.ts';

export type Value = string | number | boolean;

export interface Expect {
  /** Required on transition steps; optional on auxiliary steps (= stay on the previous screen). */
  screen?: string;
  visible?: string[];
  hidden?: string[];
  text?: Record<string, string>;
  count?: Record<string, number>;
}

/** A transition step has `event`; a step without `event` is an auxiliary step. */
export interface Step {
  event?: string;
  /** Platforms the (auxiliary) step runs on (`desktop` = wpf + winforms). */
  only?: OnlyValue;
  input?: Record<string, Value>;
  click?: string;
  do?: string;
  wait?: number;
  expect?: Expect;
  /** Evidence to capture on this step (`@ddv/evidence/spec`). */
  evidence?: EvidenceSpecInput[];
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
