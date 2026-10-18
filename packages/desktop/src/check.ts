// lint: names of the desktop scenarios exist in the screen definitions (desktop-scenario.md「名前の検査（lint）」).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DdvConfig, DocEntry, LintIssue, RunnerConfig } from '@ddv/core';
import { eventOf, findScenarioFiles, lineAt, mocksRootOf, normalizeScreenMap, parseScenarioFile, planSteps, resolveDesktopName, SCREEN_MAP_FILE, type PlatformMap, type Scenario } from '@ddv/mock';
import YAML from 'yaml';
import { nodeScreenDefFs, scanScreenDefs, screenScope, type ScreenDefFs, type ScreenDefIndex, type ScreenScope } from './screen-defs.ts';

export const DESKTOP_NAMES_RULE = 'desktop-names';

interface MapFile {
  rel: string;
  text: string;
  map: PlatformMap;
}

/** One scenario of a mock (already parsed). */
export interface NameCheckScenario {
  file: string;
  text: string;
  scenario: Scenario;
}

export interface NameCheckInput {
  runner: Pick<RunnerConfig, 'name' | 'source'> & { platform: 'wpf' | 'winforms' };
  /** null: screen definitions could not be read. */
  index: ScreenDefIndex | null;
  scenarios: NameCheckScenario[];
  /** `_map.yaml` of each scenario file's mock (by scenario file). */
  /** 'invalid': the scenario is skipped (checkMocks reports the map). */
  mapOf: (scenarioFile: string) => MapFile | null | 'invalid';
}

/** Checks one runner (DD-DSCN-SCRFILE・DD-DSCN-NAMECHK). */
export function checkRunnerNames(input: NameCheckInput): LintIssue[] {
  const { runner, index } = input;
  const platform = runner.platform;
  const issues: LintIssue[] = [];
  if (!index) {
    issues.push({ severity: 'warning', rule: DESKTOP_NAMES_RULE, path: runner.source ?? '', message: `ランナー ${runner.name} の画面定義（source: ${runner.source ?? ''}）が見つかりません。名前の検査を省略します` });
    return issues;
  }
  const screenNotes = new Set<string>();
  for (const sc of input.scenarios) {
    const got = input.mapOf(sc.file);
    if (got === 'invalid') continue;
    const mf = got;
    const map = mf?.map;
    const scopes = new Map<string, ScreenScope>();
    const scopeOf = (stateId: string, at: PropertyKey[]): ScreenScope => {
      let s = scopes.get(stateId);
      if (!s) {
        s = screenScope(index, map?.screens[stateId], stateId);
        scopes.set(stateId, s);
      }
      const note = `${stateId}\0${s.kind}`;
      if (s.kind !== 'file' && !screenNotes.has(note)) {
        screenNotes.add(note);
        if (s.kind === 'project') {
          issues.push({ severity: 'warning', rule: DESKTOP_NAMES_RULE, path: sc.file, line: lineAt(sc.text, at), message: `ランナー ${runner.name}（${platform}）: 画面 ${stateId} は title で見分けるため、定義のファイルを特定できません。プロジェクト全体の名前で調べます` });
        } else {
          const what = platform === 'wpf' ? 'Window・Page・UserControl' : 'Form・UserControl';
          issues.push({ severity: 'error', rule: DESKTOP_NAMES_RULE, path: sc.file, line: lineAt(sc.text, at), message: `ランナー ${runner.name}（${platform}）: 画面 ${stateId} の定義（x:Name・AutomationId が ${s.name} の ${what}）が見つかりません` });
        }
      }
      return s;
    };
    const reported = new Set<string>();
    const s = sc.scenario;
    scopeOf(s.start, ['start']);
    let from = s.start;
    for (const plan of planSteps(s, platform)) {
      if (!plan.run) continue;
      const i = plan.index;
      const step = plan.step;
      const to = plan.expect.screen ?? from;
      if (step.expect?.screen !== undefined) scopeOf(to, ['steps', i, 'expect', 'screen']);
      const check = (key: string, kind: 'event' | 'field', screen: string, at: PropertyKey[], event?: string) => {
        if (map?.ignore.includes(key)) return;
        const scope = scopes.get(screen) ?? scopeOf(screen, at);
        if (scope.kind === 'missing') return;
        const r = resolveDesktopName(kind, key, map, event);
        if (scope.names.has(r.name) || reported.has(r.name)) return;
        reported.add(r.name);
        if (r.mapped) {
          const section = kind === 'event' ? 'events' : 'fields';
          const logical = kind === 'event' ? eventOf(event!) : key;
          issues.push({ severity: 'error', rule: DESKTOP_NAMES_RULE, path: mf!.rel, line: lineAt(mf!.text, [platform, section, logical]), message: `_map.yaml の ${platform}.${section}.${logical} の読み替え先 ${r.name} が画面 ${screen} にありません` });
        } else {
          issues.push({ severity: 'error', rule: DESKTOP_NAMES_RULE, path: sc.file, line: lineAt(sc.text, at), message: `シナリオ ${s.id} ステップ ${i + 1}（${platform}）: 画面 ${screen} に名前 ${r.name} がありません（x:Name / Name を付けるか、_map.yaml の ${platform}.events / fields で読み替えてください）` });
        }
      };
      for (const k of Object.keys(step.input ?? {})) check(k, 'field', from, ['steps', i, 'input', k]);
      if (step.click !== undefined) {
        if (step.event !== undefined) check(step.click, 'event', from, ['steps', i, 'click'], step.event);
        else check(step.click, 'field', from, ['steps', i, 'click']);
      }
      const e = step.expect ?? {};
      for (const k of e.visible ?? []) check(k, 'field', to, ['steps', i, 'expect', 'visible']);
      for (const k of e.hidden ?? []) check(k, 'field', to, ['steps', i, 'expect', 'hidden']);
      for (const k of Object.keys(e.text ?? {})) check(k, 'field', to, ['steps', i, 'expect', 'text', k]);
      for (const k of Object.keys(e.count ?? {})) check(k, 'field', to, ['steps', i, 'expect', 'count', k]);
      from = to;
    }
  }
  return issues;
}

/** `ExtraLintCheck` of lint and `/api/lint`: every `type: flaui` runner. */
export async function checkDesktopNames(repoRoot: string, config: DdvConfig, _docs?: DocEntry[], io: ScreenDefFs = nodeScreenDefFs(repoRoot)): Promise<LintIssue[]> {
  const runners = config.runners.filter((r) => r.type === 'flaui' && (r.platform === 'wpf' || r.platform === 'winforms') && r.source);
  if (!runners.length) return [];
  const scenarios: NameCheckScenario[] = [];
  const mockOf = new Map<string, string>();
  for (const entry of findScenarioFiles(repoRoot, config)) {
    const text = readFileSync(path.join(repoRoot, entry.file), 'utf8');
    const sf = parseScenarioFile(text, entry.file);
    if (!sf.scenario) continue;
    scenarios.push({ file: entry.file, text, scenario: sf.scenario });
    mockOf.set(entry.file, entry.mock);
  }
  const mocksRoot = mocksRootOf(config);
  const maps = new Map<string, { rel: string; text: string; raw: unknown; invalid?: boolean } | null>();
  const rawMap = (mock: string) => {
    if (!maps.has(mock)) {
      const rel = `${mocksRoot}/${mock}/scenarios/${SCREEN_MAP_FILE}`;
      const abs = path.join(repoRoot, rel);
      let v: { rel: string; text: string; raw: unknown; invalid?: boolean } | null = null;
      if (existsSync(abs)) {
        const text = readFileSync(abs, 'utf8');
        try {
          v = { rel, text, raw: YAML.parse(text) };
        } catch {
          v = { rel, text, raw: undefined, invalid: true };
        }
      }
      maps.set(mock, v);
    }
    return maps.get(mock) ?? null;
  };
  const issues: LintIssue[] = [];
  for (const runner of runners) {
    const platform = runner.platform as 'wpf' | 'winforms';
    const index = await scanScreenDefs(io, runner.source!, platform);
    issues.push(
      ...checkRunnerNames({
        runner: { name: runner.name, source: runner.source, platform },
        index,
        scenarios,
        mapOf: (file) => {
          const m = rawMap(mockOf.get(file) ?? '');
          if (!m) return null;
          if (m.invalid) return 'invalid';
          const r = normalizeScreenMap(m.raw);
          // an invalid _map.yaml is reported by checkMocks
          return r.ok ? { rel: m.rel, text: m.text, map: r.map.of(platform) } : 'invalid';
        },
      }),
    );
  }
  return issues;
}
