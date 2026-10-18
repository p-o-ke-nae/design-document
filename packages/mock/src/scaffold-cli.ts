import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import YAML, { isMap, isScalar, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import type { DdvConfig } from '@ddv/core';
import { loadDocs, safeJoin, type DocEntry } from '@ddv/core/node';
import { diagramKeyOf, readLock, type TestIdLock } from '@ddv/testid';
import { analyzeMockHtml, type MockModel } from './analyze.ts';
import { mergeScenario, type MergeSource } from './merge.ts';
import { pathSpecs } from './paths.ts';
import { mockTargets, scenariosDir, targetDiagram, RETIRED_DIR, type MockTarget } from './targets.ts';

export { mockTargets, scenariosDir, targetDiagram, RETIRED_DIR, type MockTarget };
import { scaffoldScenario, type TodoPath } from './scaffold.ts';
import { collectTodos, parseScenarioFile, TODO_MARK } from './scenario.ts';
import { SCREEN_MAP_FILE } from './map.ts';
import type { PathSpec, Scenario, Step } from './types.ts';

export const SCENARIO_HEADER = ' ddv mock scaffold が生成。event / click / expect.screen は再生成で更新、それ以外は保持';
const KEY_ORDER = ['id', 'title', 'fixtures', 'start', 'steps'];
const STEP_ORDER = ['event', 'only', 'input', 'click', 'do', 'wait', 'expect', 'evidence'];
const TODO_COMMENT = ` ${TODO_MARK}`;

/** Scenario files (repo-relative) of a mock, excluding `_map.yaml`, `_retired/` and other `_` files. */
export async function listScenarioFiles(repoRoot: string, config: DdvConfig, mock: string): Promise<string[]> {
  const dir = scenariosDir(config, mock);
  const abs = safeJoin(repoRoot, dir);
  if (!existsSync(abs)) return [];
  const ents = await fs.readdir(abs, { withFileTypes: true });
  return ents
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name) && !e.name.startsWith('_'))
    .map((e) => `${dir}/${e.name}`)
    .sort();
}

export async function loadMockModel(repoRoot: string, config: DdvConfig, target: string): Promise<MockModel | null> {
  const p = safeJoin(repoRoot, `${config.mocksRoot}/${target}`);
  if (!existsSync(p)) return null;
  return analyzeMockHtml(await fs.readFile(p, 'utf8'));
}

function orderMap(map: YAMLMap, order: string[]) {
  const rank = (k: unknown) => {
    const i = order.indexOf(String(isScalar(k) ? k.value : k));
    return i < 0 ? order.length : i;
  };
  map.items.sort((a, b) => rank(a.key) - rank(b.key));
}

function markTodos(doc: Document, todos: TodoPath[], prefix: TodoPath = []) {
  for (const p of todos) {
    const node = doc.getIn([...prefix, ...p], true);
    if (isScalar(node) || isMap(node)) node.comment = TODO_COMMENT;
  }
}

function stepNode(doc: Document, step: Step, todos: TodoPath[]): YAMLMap {
  const node = doc.createNode(step) as YAMLMap;
  orderMap(node, STEP_ORDER);
  const expect = node.get('expect', true);
  if (isMap(expect)) expect.flow = true;
  const input = node.get('input', true);
  if (isMap(input) && !todos.some((t) => t[0] === 'input' && t.length > 1)) input.flow = true;
  for (const t of todos) {
    const n = node.getIn(t, true);
    if (isScalar(n) || isMap(n)) n.comment = TODO_COMMENT;
  }
  return node;
}

/** Builds a new scenario document (key order id, title, fixtures, start, steps; todos as `# 要確認`). */
export function scenarioDocument(s: Scenario, todos: TodoPath[]): Document {
  const doc = new YAML.Document();
  doc.commentBefore = SCENARIO_HEADER;
  const root = doc.createNode({ id: s.id, title: s.title, fixtures: s.fixtures, start: s.start }) as YAMLMap;
  const fixtures = root.get('fixtures', true);
  if (isSeq(fixtures)) fixtures.flow = true;
  const steps = new YAML.YAMLSeq();
  s.steps.forEach((st, i) => steps.items.push(stepNode(doc, st, stepTodos(todos, i))));
  root.set('steps', steps);
  doc.contents = root;
  return doc;
}

function stepTodos(todos: TodoPath[], i: number): TodoPath[] {
  return todos.filter((t) => t[0] === 'steps' && t[1] === i).map((t) => t.slice(2));
}

function setScalar(map: YAMLMap, key: string, value: unknown, todo: boolean) {
  const cur = map.get(key, true);
  if (isScalar(cur)) {
    if (cur.value === value) return;
    cur.value = value;
    cur.comment = todo ? TODO_COMMENT : cur.comment?.includes(TODO_MARK) ? undefined : cur.comment;
    return;
  }
  const n = new YAML.Scalar(value);
  if (todo) n.comment = TODO_COMMENT;
  map.set(key, n);
}

/** Applies a merge result to an existing document, keeping human comments on retained nodes. */
export function updateScenarioDocument(doc: Document, merged: Scenario, sources: MergeSource[], todos: TodoPath[]): Document {
  const root = doc.contents;
  if (!isMap(root)) return scenarioDocument(merged, todos);
  setScalar(root, 'id', merged.id, false);
  setScalar(root, 'title', merged.title, false);
  setScalar(root, 'start', merged.start, false);
  if (!root.has('fixtures')) {
    const f = doc.createNode(merged.fixtures) as YAMLSeq;
    f.flow = true;
    root.set('fixtures', f);
  }
  const old = root.get('steps', true);
  const oldItems = isSeq(old) ? old.items : [];
  const items = merged.steps.map((s, i) => {
    const src = sources[i];
    const t = stepTodos(todos, i);
    const node = src.step !== null ? oldItems[src.step] : undefined;
    if (src.aux && node) return node;
    if (!isMap(node)) return stepNode(doc, s, t);
    setScalar(node, 'event', s.event, false);
    if (s.click === undefined) node.delete('click');
    else setScalar(node, 'click', s.click, t.some((x) => x.length === 1 && x[0] === 'click'));
    if (src.input === 'generated' && s.input) {
      const tmp = stepNode(doc, { event: s.event, input: s.input, expect: s.expect }, t);
      node.set('input', tmp.get('input', true));
    }
    const ex = node.get('expect', true);
    if (isMap(ex)) setScalar(ex, 'screen', s.expect?.screen, false);
    else node.set('expect', stepNode(doc, s, []).get('expect', true));
    orderMap(node, STEP_ORDER);
    return node;
  });
  if (isSeq(old)) old.items = items;
  else {
    const seq = new YAML.YAMLSeq();
    seq.items = items;
    root.set('steps', seq);
  }
  orderMap(root, KEY_ORDER);
  return doc;
}

export interface ScaffoldCounts {
  added: number;
  updated: number;
  retired: number;
  /** `# 要確認` marks remaining in the scenarios after scaffolding. */
  todo: number;
  unchanged: number;
  /** Existing files left untouched because they are not valid scenarios. */
  skipped: string[];
  mocks: string[];
  warnings: string[];
  /** Per-scenario notes such as 「<ID>: 更新（補助ステップを 1 件削除）」. */
  notes: string[];
}

const stringify = (doc: Document) => doc.toString({ lineWidth: 0 });

async function writeText(repoRoot: string, rel: string, text: string) {
  const abs = safeJoin(repoRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
}

async function scaffoldOne(repoRoot: string, config: DdvConfig, t: MockTarget, specs: PathSpec[], counts: ScaffoldCounts) {
  const model = (await loadMockModel(repoRoot, config, t.target)) ?? { screens: new Map() };
  const mockDir = `${config.mocksRoot.replace(/\\/g, '/').replace(/\/$/, '')}/${t.name}`;
  const fixtures = existsSync(safeJoin(repoRoot, `${mockDir}/fixtures/default.yaml`)) ? ['default'] : [];
  const dir = scenariosDir(config, t.name);
  const ids = new Set(specs.map((s) => s.id));

  for (const spec of specs) {
    const { scenario: generated, todos } = scaffoldScenario(spec, model, { fixtures });
    const rel = `${dir}/${spec.id}.yaml`;
    const retiredRel = `${dir}/${RETIRED_DIR}/${spec.id}.yaml`;
    const fromRetired = !existsSync(safeJoin(repoRoot, rel)) && existsSync(safeJoin(repoRoot, retiredRel));
    const srcRel = fromRetired ? retiredRel : rel;
    if (!existsSync(safeJoin(repoRoot, srcRel))) {
      await writeText(repoRoot, rel, stringify(scenarioDocument(generated, todos)));
      counts.added++;
      continue;
    }
    const text = await fs.readFile(safeJoin(repoRoot, srcRel), 'utf8');
    const parsed = parseScenarioFile(text, srcRel);
    if (!parsed.scenario) {
      counts.skipped.push(srcRel);
      continue;
    }
    const m = mergeScenario(parsed.scenario, generated);
    const keptTodos = todos
      .filter((p) => {
        const src = m.sources[m.positions[p[1] as number]];
        return p[2] === 'click' || src.step === null || (p[2] === 'input' && src.input === 'generated');
      })
      .map((p) => (p[0] === 'steps' && typeof p[1] === 'number' ? ['steps', m.positions[p[1]], ...p.slice(2)] : p));
    if (m.unchanged && !fromRetired) {
      counts.unchanged++;
      continue;
    }
    const doc = updateScenarioDocument(YAML.parseDocument(text), m.scenario, m.sources, keptTodos);
    await writeText(repoRoot, rel, stringify(doc));
    if (m.auxRemoved) counts.notes.push(`${spec.id}: ${fromRetired ? '追加' : '更新'}（補助ステップを ${m.auxRemoved} 件削除）`);
    if (fromRetired) {
      await fs.rm(safeJoin(repoRoot, retiredRel));
      counts.added++;
    } else counts.updated++;
  }

  for (const rel of await listScenarioFiles(repoRoot, config, t.name)) {
    const id = path.posix.basename(rel).replace(/\.ya?ml$/, '');
    if (ids.has(id) || path.posix.basename(rel) === SCREEN_MAP_FILE) continue;
    const dest = `${dir}/${RETIRED_DIR}/${path.posix.basename(rel)}`;
    await fs.mkdir(path.dirname(safeJoin(repoRoot, dest)), { recursive: true });
    await fs.rm(safeJoin(repoRoot, dest), { force: true });
    await fs.rename(safeJoin(repoRoot, rel), safeJoin(repoRoot, dest));
    counts.retired++;
  }

  for (const rel of await listScenarioFiles(repoRoot, config, t.name)) {
    counts.todo += collectTodos(await fs.readFile(safeJoin(repoRoot, rel), 'utf8')).length;
  }
}

/** Generates / merges scenario skeletons for one mock (or all mocks referenced from documents). */
export async function scaffoldMock(repoRoot: string, config: DdvConfig, mockName?: string, opts: { docs?: DocEntry[]; lock?: TestIdLock } = {}): Promise<ScaffoldCounts> {
  const docs = opts.docs ?? (await loadDocs(repoRoot, config));
  const lock = opts.lock ?? (await readLock(repoRoot));
  let targets = mockTargets(docs);
  if (mockName) {
    targets = targets.filter((t) => t.name === mockName);
    if (!targets.length) throw new Error(`モック ${mockName} を参照する文書（::mock[${mockName}/index.html]）がありません`);
  }
  const counts: ScaffoldCounts = { added: 0, updated: 0, retired: 0, todo: 0, unchanged: 0, skipped: [], mocks: [], warnings: [], notes: [] };
  for (const t of targets) {
    const sd = targetDiagram(t);
    if (!sd) {
      counts.warnings.push(`モック ${t.name}: ${t.doc.path} に matrix 付きの状態図${t.diagram ? ` ${t.diagram}` : ''}がありません`);
      continue;
    }
    if (!lock.diagrams[diagramKeyOf(t.doc, sd.diagram, config)]) {
      counts.warnings.push(`モック ${t.name}: 図 ${sd.diagram.id} がロックにありません。先に ddv-testid generate を実行してください`);
      continue;
    }
    counts.mocks.push(t.name);
    await scaffoldOne(repoRoot, config, t, pathSpecs(t.doc, sd.diagram, lock, config), counts);
  }
  return counts;
}
