import { z } from 'zod';
import YAML, { isNode, LineCounter, type Document } from 'yaml';
import type { Scenario } from './types.ts';

export const TODO_MARK = '要確認';

export const ValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const ExpectSchema = z.strictObject({
  screen: z.string().min(1),
  visible: z.array(z.string()).optional(),
  hidden: z.array(z.string()).optional(),
  text: z.record(z.string(), z.string()).optional(),
  count: z.record(z.string(), z.number().int().min(0)).optional(),
});

export const StepSchema = z.strictObject({
  event: z.string().min(1),
  input: z.record(z.string(), ValueSchema).optional(),
  click: z.string().optional(),
  do: z.string().optional(),
  wait: z.number().min(0).optional(),
  expect: ExpectSchema,
});

export const ScenarioSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().default(''),
  fixtures: z.array(z.string()).default([]),
  start: z.string().min(1),
  steps: z.array(StepSchema).default([]),
});

export interface TodoMark {
  line: number;
  /** Key on the marked line (e.g. `customer`, `click`). */
  key: string;
}

export interface ScenarioIssue {
  line?: number;
  /** Property path like `steps.1.expect.screen`. */
  path: string;
  message: string;
}

export interface ScenarioFile {
  path: string;
  scenario?: Scenario;
  todos: TodoMark[];
  issues: ScenarioIssue[];
}

/** Lines carrying a `# 要確認` comment. */
export function collectTodos(text: string): TodoMark[] {
  const out: TodoMark[] = [];
  const re = new RegExp(`(?:^|\\s)#\\s*${TODO_MARK}`);
  text.split(/\r?\n/).forEach((line, i) => {
    if (!re.test(line)) return;
    const m = /^\s*(?:-\s+)?([^:#]+?)\s*:/.exec(line);
    out.push({ line: i + 1, key: m ? m[1].replace(/^["']|["']$/g, '') : '' });
  });
  return out;
}

function lineOf(doc: Document, lc: LineCounter, path: PropertyKey[]): number | undefined {
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n) as unknown[], true);
    if (isNode(node) && node.range) return lc.linePos(node.range[0]).line;
  }
  return undefined;
}

/** Line (1-based) of the node at `path` (or its nearest existing ancestor) in a YAML text. */
export function lineAt(text: string, path: PropertyKey[]): number | undefined {
  const lc = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter: lc, prettyErrors: false });
  return lineOf(doc, lc, path);
}

export function parseScenarioFile(text: string, path: string): ScenarioFile {
  const todos = collectTodos(text);
  const lc = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter: lc, prettyErrors: false });
  if (doc.errors.length) {
    return {
      path,
      todos,
      issues: doc.errors.map((e) => ({ line: lc.linePos(e.pos[0]).line, path: '', message: `YAML が不正です: ${e.message.split('\n')[0]}` })),
    };
  }
  const r = ScenarioSchema.safeParse(doc.toJS());
  if (!r.success) {
    return {
      path,
      todos,
      issues: r.error.issues.map((i) => ({
        line: lineOf(doc, lc, i.path),
        path: i.path.map(String).join('.'),
        message: `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`,
      })),
    };
  }
  return { path, scenario: r.data as Scenario, todos, issues: [] };
}
