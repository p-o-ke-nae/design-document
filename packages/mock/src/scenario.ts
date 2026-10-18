import { z } from 'zod';
import YAML, { isNode, LineCounter, type Document } from 'yaml';
import type { Scenario } from './types.ts';
import { EvidenceListSchema, validateEvidence } from '@ddv/evidence/spec';
import { isOnlyValue, onlyList, ONLY_VALUES } from './platform.ts';

export const TODO_MARK = '要確認';

export const ValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const ExpectSchema = z.strictObject({
  screen: z.string().min(1).optional(),
  visible: z.array(z.string()).optional(),
  hidden: z.array(z.string()).optional(),
  text: z.record(z.string(), z.string()).optional(),
  count: z.record(z.string(), z.number().int().min(0)).optional(),
});

/** Shape only: the combination of `event` / `only` / `expect` is checked by `validateScenario`. */
export const StepSchema = z.strictObject({
  event: z.string().min(1).optional(),
  only: z.union([z.string(), z.array(z.string())]).optional(),
  input: z.record(z.string(), ValueSchema).optional(),
  click: z.string().optional(),
  do: z.string().optional(),
  wait: z.number().min(0).optional(),
  expect: ExpectSchema.optional(),
  evidence: EvidenceListSchema.optional(),
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
  const raw = doc.toJS();
  const r = ScenarioSchema.safeParse(raw);
  const semantic = (s: Pick<Scenario, 'id' | 'steps'>, skip: string[] = []) =>
    validateScenario(s)
      .filter((i) => !skip.some((p) => p === i.path || p.startsWith(`${i.path}.`) || i.path.startsWith(`${p}.`)))
      .map((i) => ({ ...i, line: lineOf(doc, lc, toKeys(i.path)) }));
  if (!r.success) {
    const issues: ScenarioIssue[] = r.error.issues.map((i) => ({
      line: lineOf(doc, lc, i.path),
      path: i.path.map(String).join('.'),
      message: `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`,
    }));
    // Best effort: also report the step-level checks of steps that have the right shape.
    const steps: unknown = raw && typeof raw === 'object' ? (raw as { steps?: unknown }).steps : undefined;
    if (Array.isArray(steps) && steps.every((s) => s && typeof s === 'object' && !Array.isArray(s))) {
      issues.push(...semantic({ id: String((raw as { id?: unknown }).id ?? ''), steps: steps as Scenario['steps'] }, issues.map((i) => i.path)));
    }
    return { path, todos, issues };
  }
  const invalid = semantic(r.data as Scenario);
  if (invalid.length) return { path, todos, issues: invalid };
  return { path, scenario: r.data as Scenario, todos, issues: [] };
}

/** `steps.1.only` → ['steps', 1, 'only'] (YAML node path). */
const toKeys = (p: string): PropertyKey[] => (p ? p.split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x)) : []);

/** Path of an issue as `parseScenarioFile` reports it (`steps.1.only`). */
const stepPath = (i: number, ...rest: string[]) => ['steps', String(i), ...rest].join('.');

/**
 * Semantic checks of a parsed scenario (detailed design: シナリオの形式の検査): `only` values, `only` on transition steps,
 * `expect.screen` of transition steps and empty auxiliary steps. Locations are "シナリオ <ID> のステップ <n>" (1-based, auxiliary steps included).
 */
export function validateScenario(scenario: Pick<Scenario, 'id' | 'steps'>): ScenarioIssue[] {
  const issues: ScenarioIssue[] = [];
  const evidence = validateEvidence(scenario);
  scenario.steps.forEach((step, i) => {
    checkStep(step, i);
    // evidence-spec.md#形式の検査: evidence issues follow the step's own issue.
    issues.push(...evidence.filter((e) => e.path.startsWith(`${stepPath(i)}.`)));
  });
  return issues;

  function checkStep(step: Scenario['steps'][number], i: number) {
    const at = `シナリオ ${scenario.id} のステップ ${i + 1}`;
    const add = (path: string, message: string) => issues.push({ path, message: `${at}: ${message}` });
    if (step.only !== undefined) {
      const values = onlyList(step.only);
      if (!values.length) return add(stepPath(i, 'only'), 'only が空です');
      const unknown = values.filter((v) => !isOnlyValue(v));
      if (unknown.length) return add(stepPath(i, 'only'), `不明なプラットフォームです: ${unknown.join(', ')}（${ONLY_VALUES.join(' / ')}）`);
    }
    if (step.event !== undefined) {
      if (step.only !== undefined) return add(stepPath(i, 'only'), '遷移のステップに only は付けられません（図とシナリオを分けてください）');
      if (step.expect?.screen === undefined) return add(stepPath(i, 'expect'), '遷移のステップには expect.screen が必要です');
      return;
    }
    const hasAny = step.click !== undefined || step.input !== undefined || step.do !== undefined || step.wait !== undefined || step.expect !== undefined;
    // `evidence` alone does not make an auxiliary step (write it on the previous step instead).
    if (!hasAny) add(stepPath(i), '補助ステップに操作も期待もありません');
  }
}
