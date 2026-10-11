import type { MockModel } from './analyze.ts';
import { inferInput } from './infer.ts';
import { transitionLabel } from './match.ts';
import type { PathSpec, Scenario, Step } from './types.ts';

/** Path inside the scenario object, e.g. ['steps', 1, 'input', 'zip']. */
export type TodoPath = Array<string | number>;

export interface ScaffoldResult {
  scenario: Scenario;
  todos: TodoPath[];
}

export function scaffoldScenario(path: PathSpec, mock: MockModel, opts: { fixtures?: string[] } = {}): ScaffoldResult {
  const todos: TodoPath[] = [];
  const steps: Step[] = path.transitions.map((t, i) => {
    const screen = mock.screens.get(t.from);
    const click = screen?.events.get(t.event) ?? '';
    const step: Step = { event: transitionLabel(t), expect: { screen: t.to } };
    if (t.guard || (click && screen?.submitters.has(click))) {
      const mode = t.to === t.from ? 'ng' : 'ok';
      const fields = screen?.fields ?? [];
      if (fields.length || mode === 'ng') {
        const r = inferInput(fields, mode);
        step.input = r.input;
        if (r.todoAll) todos.push(['steps', i, 'input']);
        for (const k of r.todos) todos.push(['steps', i, 'input', k]);
      }
    }
    step.click = click;
    if (!click) todos.push(['steps', i, 'click']);
    return { event: step.event, ...(step.input ? { input: step.input } : {}), click: step.click, expect: step.expect };
  });
  return {
    scenario: { id: path.id, title: path.title, fixtures: opts.fixtures ?? [], start: path.start, steps },
    todos,
  };
}
