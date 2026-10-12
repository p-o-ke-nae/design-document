/**
 * Whether an operation is enabled on the screens (pages-viewer.md「操作の可否」).
 * The Pages edition sets an `OperationGate`; the local edition never does, so every operation stays enabled (REQ-610).
 */
import { useSyncExternalStore } from 'react';
import type { GateResult, OperationId } from './backend/types.ts';

export interface GateLike {
  check(op: OperationId): GateResult;
}

const ENABLED: GateResult = { enabled: true };
let gate: GateLike | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** Replaces the gate (target opened / closed). */
export function setGate(g: GateLike | null): void {
  gate = g;
  notifyGate();
}

/** The answers changed (PAT set / cleared, permission probed). */
export function notifyGate(): void {
  version++;
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function checkGate(op: OperationId): GateResult {
  return gate ? gate.check(op) : ENABLED;
}

/** `{ enabled, reason }` of an operation, re-rendered when the gate changes. */
export function useGate(op: OperationId): GateResult {
  useSyncExternalStore(subscribe, () => version);
  return checkGate(op);
}

/** The reason next to a disabled operation (the same text as its `title`). */
export function GateReason({ gate: g }: { gate: GateResult }) {
  if (g.enabled || !g.reason) return null;
  return (
    <span className="disabled-reason" data-testid="disabled-reason">
      {g.reason}
    </span>
  );
}
