// Input scope and argument resolution (detailed design evidence-spec.md#入力値の範囲・#引数の解決). Browser-safe.
import { isInputRef, type EvidenceWith, type Scalar } from './spec.ts';

interface ScopeStep {
  input?: Readonly<Record<string, Scalar>>;
}
interface ScopePlan {
  /** 0-based index in the scenario file. */
  index: number;
  run: boolean;
}

/** Values `{ input: <key> }` can refer to, per platform plan (SCOPE). Step indices are 0-based file indices. */
export class InputScope {
  private constructor(private readonly inputs: ReadonlyArray<Readonly<Record<string, Scalar>> | undefined>) {}

  /** `plan` is the result of `planSteps(scenario, platform)`; skipped steps (run=false) contribute nothing. */
  static of(scenario: { steps: readonly ScopeStep[] }, plan: readonly ScopePlan[]): InputScope {
    const inputs: Array<Readonly<Record<string, Scalar>> | undefined> = scenario.steps.map(() => undefined);
    for (const p of plan) if (p.run) inputs[p.index] = scenario.steps[p.index]?.input;
    return new InputScope(inputs);
  }

  /** Inputs of steps before `stepIndex` (`at: before`). */
  before(stepIndex: number): Map<string, Scalar> {
    return this.collect(stepIndex);
  }

  /** Inputs of steps up to and including `stepIndex` (`at: after`). */
  after(stepIndex: number): Map<string, Scalar> {
    return this.collect(stepIndex + 1);
  }

  at(at: 'before' | 'after', stepIndex: number): Map<string, Scalar> {
    return at === 'before' ? this.before(stepIndex) : this.after(stepIndex);
  }

  private collect(end: number): Map<string, Scalar> {
    const out = new Map<string, Scalar>();
    for (let i = 0; i < Math.min(end, this.inputs.length); i++) for (const [k, v] of Object.entries(this.inputs[i] ?? {})) out.set(k, v);
    return out;
  }
}

export type ResolvedValue = Scalar | Scalar[];
/** Arguments passed to a provider (`params` of `db` stays a one-level map). */
export type ResolvedArgs = Record<string, ResolvedValue | Record<string, ResolvedValue>>;

export type ResolveResult = { ok: true; args: ResolvedArgs } | { ok: false; missing: string[]; message: string };

export const missingInputMessage = (key: string) => `入力 ${key} はこの時点ではありません`;

/** Resolves `with` against the inputs available at that time (WITH). Plain maps (`db`'s `params`) are resolved one level deep. */
export function resolveWith(w: EvidenceWith, scope: ReadonlyMap<string, Scalar>): ResolveResult {
  const missing: string[] = [];
  const one = (v: unknown): ResolvedValue | undefined => {
    if (isInputRef(v)) {
      if (scope.has(v.input)) return scope.get(v.input);
      if (!missing.includes(v.input)) missing.push(v.input);
      return undefined;
    }
    return Array.isArray(v) ? [...v] : (v as Scalar);
  };
  const args: ResolvedArgs = {};
  for (const [k, v] of Object.entries(w)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !isInputRef(v)) {
      const inner: Record<string, ResolvedValue> = {};
      for (const [ik, iv] of Object.entries(v)) {
        const r = one(iv);
        if (r !== undefined) inner[ik] = r;
      }
      args[k] = inner;
      continue;
    }
    const r = one(v);
    if (r !== undefined) args[k] = r;
  }
  if (missing.length) return { ok: false, missing, message: missing.map(missingInputMessage).join('、') };
  return { ok: true, args };
}
