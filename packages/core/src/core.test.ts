import { describe, expect, it } from 'vitest';
import { docEntryOf, isOwnerAllowed, lintDocsWith, lintTargets, PagesConfigSchema, PagesTargetSchema, parseConfig, parseConfigText } from './index.ts';

describe('isOwnerAllowed（OWNERS）', () => {
  it('[DD-PAT-OWNERS-P001] [DD-PAT-OWNERS-T001] [DD-PAT-OWNERS-T002] allowedOwners が未指定なら true', () => {
    expect(isOwnerAllowed('anyone', undefined)).toBe(true);
  });

  it('[DD-PAT-OWNERS-P002] [DD-PAT-OWNERS-T003] [DD-PAT-OWNERS-T004] 大文字小文字を区別せず一致すれば true', () => {
    expect(isOwnerAllowed('ACME', ['acme', 'other'])).toBe(true);
    expect(isOwnerAllowed('other', ['acme', 'Other'])).toBe(true);
  });

  it('[DD-PAT-OWNERS-P003] [DD-PAT-OWNERS-T005] 一致する owner が無ければ false', () => {
    expect(isOwnerAllowed('evil', ['acme'])).toBe(false);
    expect(isOwnerAllowed('acm', ['acme'])).toBe(false);
  });
});

describe('PagesConfigSchema', () => {
  it('既定値を補い、allowedOwners に無い owner の対象はエラー', () => {
    expect(PagesConfigSchema.parse({})).toEqual({ title: 'ddv', recentTargets: [] });
    const r = PagesConfigSchema.safeParse({ allowedOwners: ['acme'], defaultTarget: { repo: 'acme/a' }, recentTargets: [{ repo: 'ACME/b', pr: 1 }, { repo: 'evil/c' }] });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['recentTargets.1', 'allowedOwners に無い owner です: evil/c']]);
    expect(PagesConfigSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it('PagesTargetSchema は repo の形式と pr・ref の排他を検査する', () => {
    expect(PagesTargetSchema.safeParse({ repo: 'acme' }).error?.issues[0].message).toBe('owner/repo の形式で書いてください');
    expect(PagesTargetSchema.safeParse({ repo: 'acme/a', pr: 1, ref: 'main' }).error?.issues[0].message).toBe('pr と ref はどちらか一方だけ書いてください');
    expect(PagesTargetSchema.parse({ repo: 'acme/a.b', ref: 'main', label: 'x' })).toEqual({ repo: 'acme/a.b', ref: 'main', label: 'x' });
  });
});

describe('ddv.config の pages.url', () => {
  it('https の URL だけを受け付け、末尾のスラッシュを除く', () => {
    expect(parseConfig({}).pages).toBeUndefined();
    expect(parseConfig({ pages: { url: 'https://acme.github.io/ddv/' } }).pages).toEqual({ url: 'https://acme.github.io/ddv' });
    expect(() => parseConfig({ pages: { url: 'http://acme.github.io/ddv' } })).toThrow('pages.url は https:// で始まる URL を書いてください');
  });
});

describe('ブラウザ用の純関数', () => {
  it('parseConfigText は拡張子で JSON / YAML を切り替える', () => {
    expect(parseConfigText('ddv.config.json', '{"docsRoot":"d"}').docsRoot).toBe('d');
    expect(parseConfigText('ddv.config.yaml', 'docsRoot: y\n').docsRoot).toBe('y');
  });

  it('docEntryOf は front matter と既定値から DocEntry を作る', () => {
    const d = docEntryOf('docs/basic/order.md', '---\nstatus: approved\n---\n# 注文\n');
    expect([d.kind, d.title, d.id, d.status]).toEqual(['basic', '注文', 'ORDER', 'approved']);
  });

  it('lintTargets の存在する集合を渡すと lintDocsWith は無いものだけ指摘する', () => {
    const config = parseConfig({});
    const docs = [docEntryOf('docs/a.md', '# A\n\n:ref[b.md] :ref[missing.md] :ref[a.md]\n\n::mock[x/index.html]\n')];
    expect(lintTargets(docs, config).sort()).toEqual(['docs/b.md', 'docs/missing.md', 'docs/mocks/x/index.html']);
    const msgs = lintDocsWith(new Set(['docs/b.md', 'docs/mocks/x/index.html']), config, docs).filter((i) => i.rule === 'ref').map((i) => i.message);
    expect(msgs).toEqual(['参照先 docs/missing.md が見つかりません']);
  });
});
