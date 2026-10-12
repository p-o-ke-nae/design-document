import YAML from 'yaml';
import { splitLabel } from '@ddv/graph';
import type { DdvConfig, DocEntry, LintIssue } from '@ddv/core';
import type { TestIdLock } from '@ddv/testid/core';
import type { MockModel } from './analyze.ts';
import { ScreenMapSchema, SCREEN_MAP_FILE } from './map.ts';
import { matchPath } from './match.ts';
import { pathSpecs } from './paths.ts';
import { lineAt, parseScenarioFile } from './scenario.ts';
import { mockTargets, scenariosDir, targetDiagram } from './targets.ts';
import type { PathSpec } from './types.ts';

const MOCK_RUNTIME_FILE = '_ddv/mock-runtime.js';

/** Version from the first line of a deployed runtime, or null when absent. */
function runtimeVersionOf(text: string): string | null {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  return /@ddv\/mock-runtime\s+v?(\S+)/.exec(first)?.[1] ?? null;
}

/** File access of `checkMocksWith` (repository-relative posix paths). */
export interface MockCheckIo {
  dirExists(rel: string): Promise<boolean>;
  /** The analyzed html of `<mocksRoot>/<target>`, or null when missing. */
  mockModel(target: string): Promise<MockModel | null>;
  /** Scenario files of a mock (`scenarios/*.yaml`, excluding `_` files), sorted. */
  scenarioFiles(mock: string): Promise<string[]>;
  readText(rel: string): Promise<string>;
  tryReadText(rel: string): Promise<string | null>;
}

const rootOf = (config: DdvConfig) => config.mocksRoot.replace(/\\/g, '/').replace(/\/$/, '');
/** ddv-lint extension for mocks and scenarios (basic design: 検査). */
export async function checkMocksWith(io: MockCheckIo, config: DdvConfig, docs: DocEntry[], lock: TestIdLock, mockVersion?: string): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const mocksRoot = rootOf(config);
  if (!(await io.dirExists(mocksRoot))) return issues;
  const theLock = lock;
  const warn = (p: string, message: string, line?: number, rule = 'mock') => issues.push({ severity: 'warning', rule, path: p, ...(line ? { line } : {}), message });
  const error = (p: string, message: string, line?: number) => issues.push({ severity: 'error', rule: 'scenario', path: p, ...(line ? { line } : {}), message });

  for (const t of mockTargets(docs)) {
    const model = await io.mockModel(t.target);
    if (!model) continue; // missing html is reported by the core ref check
    const htmlRel = `${mocksRoot}/${t.target}`;
    const sd = targetDiagram(t);
    let specs: PathSpec[] = [];
    const states = new Set<string>();
    const events = new Set<string>();

    if (sd) {
      const role = new Map(sd.graph.nodes.map((n) => [n.id, n.role]));
      for (const n of sd.graph.nodes) {
        if (n.role !== 'normal') continue;
        states.add(n.id);
        if (!model.screens.has(n.id)) warn(htmlRel, `画面遷移図 ${sd.diagram.id} の状態 ${n.label} (${n.id}) に対応する data-screen="${n.id}" がありません`);
      }
      const seen = new Set<string>();
      for (const e of sd.graph.edges) {
        if (role.get(e.from) !== 'normal') continue;
        const ev = splitLabel(e.label).event;
        if (!ev) continue;
        events.add(ev);
        const screen = model.screens.get(e.from);
        if (!screen || seen.has(`${e.from}\u0000${ev}`)) continue;
        seen.add(`${e.from}\u0000${ev}`);
        if (!screen.events.has(ev)) warn(htmlRel, `画面 ${e.from} にイベント「${ev}」の操作要素（data-event="${ev}"）がありません`);
      }
      specs = pathSpecs(t.doc, sd.diagram, theLock, config);
    }

    const specById = new Map(specs.map((s) => [s.id, s]));
    const covered = new Set<string>();
    for (const rel of await io.scenarioFiles(t.name)) {
      const text = await io.readText(rel);
      covered.add(rel.slice(rel.lastIndexOf('/') + 1).replace(/\.ya?ml$/, ''));
      const sf = parseScenarioFile(text, rel);
      if (!sf.scenario) {
        for (const i of sf.issues) error(rel, `シナリオの形式が不正です: ${i.message}`, i.line);
        continue;
      }
      const s = sf.scenario;
      covered.add(s.id);
      const spec = specById.get(s.id);
      if (!spec) {
        error(rel, `不明なテストID ${s.id}（画面遷移図の active な経路 P にありません）`, lineAt(text, ['id']));
        continue;
      }
      const m = matchPath(s, spec);
      if (!m.ok) {
        const p = m.kind === 'start' ? ['start'] : m.kind === 'count' ? ['steps'] : m.kind === 'event' ? ['steps', m.step!, 'event'] : ['steps', m.step!, 'expect', 'screen'];
        error(rel, `経路と一致しません: ${m.message}`, lineAt(text, p));
        continue;
      }
      for (const todo of sf.todos) warn(rel, `要確認の値が残っています${todo.key ? `: ${todo.key}` : ''}`, todo.line, 'scenario');
    }

    const missing = specs.filter((s) => !covered.has(s.id));
    if (missing.length) {
      warn(scenariosDir(config, t.name), `シナリオのない経路が ${missing.length} 件あります（ddv mock scaffold --mock ${t.name} を実行）: ${missing.map((s) => s.id).join(', ')}`, undefined, 'scenario');
    }

    const mapRel = `${scenariosDir(config, t.name)}/${SCREEN_MAP_FILE}`;
    const mapText = await io.tryReadText(mapRel);
    if (mapText !== null) {
      const text = mapText;
      let raw: unknown;
      try {
        raw = YAML.parse(text);
      } catch (e) {
        warn(mapRel, `対応表の YAML が不正です: ${(e as Error).message.split('\n')[0]}`, undefined, 'scenario');
        continue;
      }
      const r = ScreenMapSchema.safeParse(raw ?? {});
      if (!r.success) {
        for (const i of r.error.issues) warn(mapRel, `対応表の形式が不正です: ${i.path.join('.')}: ${i.message}`, lineAt(text, i.path), 'scenario');
      } else if (sd) {
        for (const k of Object.keys(r.data.screens)) if (!states.has(k)) warn(mapRel, `対応表の画面 ${k} は画面遷移図にありません`, lineAt(text, ['screens', k]), 'scenario');
        for (const k of Object.keys(r.data.events)) if (!events.has(k)) warn(mapRel, `対応表のイベント ${k} は画面遷移図にありません`, lineAt(text, ['events', k]), 'scenario');
      }
    }
  }

  const rtRel = `${mocksRoot}/${MOCK_RUNTIME_FILE}`;
  const rtText = mockVersion === undefined ? null : await io.tryReadText(rtRel);
  if (rtText !== null) {
    const v = runtimeVersionOf(rtText);
    if (v !== mockVersion) warn(rtRel, `mock-runtime の版（${v ?? '不明'}）が ddv の版（${mockVersion}）と違います。ddv mock init で更新してください`, 1);
  }
  return issues;
}
