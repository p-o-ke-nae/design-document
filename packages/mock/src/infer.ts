import type { FieldModel } from './analyze.ts';
import type { Value } from './types.ts';

export type InferMode = 'ok' | 'ng';

export interface Inferred {
  value: Value;
  /** true when the value could not be inferred (`# 要確認`). */
  todo: boolean;
}

const TEXT_SAMPLE = 'テスト';

function fromSample(field: FieldModel, sample: string): Value {
  if (field.kind === 'number' && sample.trim() !== '' && Number.isFinite(Number(sample))) return Number(sample);
  if (field.kind === 'checkbox' && /^(true|false)$/i.test(sample)) return sample.toLowerCase() === 'true';
  return sample;
}

/** Candidate value of one field. `firstRequired`: the field is the first required one of the step (blanked in ng mode). */
export function inferValue(field: FieldModel, mode: InferMode, firstRequired = false): Inferred {
  if (mode === 'ng' && firstRequired) return { value: '', todo: false };
  if (field.sample !== undefined) return { value: fromSample(field, field.sample), todo: false };
  switch (field.kind) {
    case 'number':
      return { value: field.min ?? 1, todo: false };
    case 'select':
      return field.options.length ? { value: field.options[0], todo: false } : { value: '', todo: true };
    case 'checkbox':
      return { value: field.required, todo: false };
    default:
      if (field.pattern) return { value: '', todo: true };
      return { value: field.maxLength !== undefined ? TEXT_SAMPLE.slice(0, field.maxLength) : TEXT_SAMPLE, todo: false };
  }
}

export interface InferredInput {
  input: Record<string, Value>;
  /** Keys whose values need review. */
  todos: string[];
  /** The whole input needs review (ng mode without required fields). */
  todoAll: boolean;
}

export function inferInput(fields: FieldModel[], mode: InferMode): InferredInput {
  const first = fields.find((f) => f.required);
  if (mode === 'ng' && !first) return { input: {}, todos: [], todoAll: true };
  const input: Record<string, Value> = {};
  const todos: string[] = [];
  for (const f of fields) {
    const r = inferValue(f, mode, f === first);
    input[f.key] = r.value;
    if (r.todo) todos.push(f.key);
  }
  return { input, todos, todoAll: false };
}
