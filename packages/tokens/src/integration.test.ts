import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@ddv/core';
import { checkTokenSets } from './drift.ts';
import { generateTokens } from './generate.ts';
import { loadWpfBaseCss, NodeTokenFs } from './node.ts';
import type { TokenFs } from './fs.ts';

const FIXTURES = fileURLToPath(new URL('../test-fixtures/', import.meta.url));
const REPO = path.join(FIXTURES, 'repo');
const EXPECTED = path.join(FIXTURES, 'expected');
const UPDATE = process.env.UPDATE_TOKEN_FIXTURES === '1';

const CONFIG = parseConfig({
  tokens: [
    { name: 'order-wpf', kind: 'xaml', sources: ['desktop/OrderApp.Wpf/App.xaml'] },
    {
      name: 'pokenae-web',
      kind: 'css',
      sources: ['../pokenae.Web/app/globals.css'],
      classes: ['page-header', 'page-lead', 'admin-card', 'tool-page', 'tool-section', 'notice', 'pill', 'sr-only', 'skip-link'],
    },
  ],
});
const OUTPUTS = ['order-wpf.css', 'pokenae-web.css', 'wpf-base.css'];

/** Reads the committed fixtures and keeps the writes in memory. */
class FixtureFs implements TokenFs {
  readonly written = new Map<string, string>();
  readonly writes: string[] = [];
  private readonly disk = new NodeTokenFs(REPO);

  async read(rel: string) {
    return this.written.get(rel) ?? this.disk.read(rel);
  }
  glob(pattern: string) {
    return this.disk.glob(pattern);
  }
  async write(rel: string, text: string) {
    this.writes.push(rel);
    this.written.set(rel, text);
  }
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');

describe('結合テスト（WPF の固定ファイルと pokenae.Web の globals.css）', () => {
  it('生成結果が固定のファイルと一致し、2 回目の生成で内容が変わらない', async () => {
    const fs = new FixtureFs();
    const wpfBaseCss = await loadWpfBaseCss();
    const first = await generateTokens(CONFIG, fs, { wpfBaseCss });
    expect(first.errors).toEqual([]);
    expect(first.sets.map((s) => s.errors)).toEqual([[], []]);
    const byName = (n: string) => fs.written.get(`docs/mocks/_tokens/${n}`);
    expect([...fs.written.keys()].sort()).toEqual(OUTPUTS.map((n) => `docs/mocks/_tokens/${n}`).sort());

    if (UPDATE) {
      await fsp.mkdir(EXPECTED, { recursive: true });
      for (const n of OUTPUTS) await fsp.writeFile(path.join(EXPECTED, n), byName(n)!, 'utf8');
      await fsp.writeFile(path.join(EXPECTED, 'report.txt'), first.sets.map((s) => JSON.stringify(s.warnings)).join('\n') + '\n', 'utf8');
    }
    for (const n of OUTPUTS) expect(byName(n), n).toBe(lf(await fsp.readFile(path.join(EXPECTED, n), 'utf8')));
    const report = lf(await fsp.readFile(path.join(EXPECTED, 'report.txt'), 'utf8')).trimEnd().split('\n');
    expect(first.sets.map((s) => s.warnings)).toEqual(report.map((l) => JSON.parse(l)));

    const snapshot = new Map(fs.written);
    const writes = fs.writes.length;
    await generateTokens(CONFIG, fs, { wpfBaseCss });
    expect(fs.writes.length).toBe(writes);
    expect(fs.written).toEqual(snapshot);
    expect(await checkTokenSets(CONFIG, fs)).toEqual({ issues: [], infos: [] });
  });
});
