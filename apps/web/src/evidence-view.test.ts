import { describe, expect, it } from 'vitest';
import { parseTable, toCsv } from './evidence-csv.ts';
import {
  DIALOG_CLOSED,
  canSave,
  evidenceBadge,
  evidenceNote,
  kindLabel,
  moveEvent,
  reduceDialog,
  rowAction,
  saveEvidence,
  saveName,
  stepMarks,
  stepTarget,
  toggleExpanded,
  useLabel,
  type DialogEvent,
  type DialogState,
  type TraceEvidence,
} from './evidence-view.ts';

const file = (name: string, kind: TraceEvidence['files'][number]['kind'] = 'image', omitted?: 'too-large' | 'branch-limit') => ({ path: `K/evidence/${name}`, kind, mime: 'x', bytes: 1, ...(omitted ? { omitted } : {}) });
const rec = (seq: number, over: Partial<TraceEvidence> = {}): TraceEvidence => ({ seq, label: `L${seq}`, use: 'screenshot', at: 'after', provider: 'builtin', status: 'ok', durationMs: 200, files: [file(`${seq}.png`)], ...over });

describe('CSV への変換（evidence-trace.md「CSV への変換」）', () => {
  it('BOM・CRLF・1 行目は columns。null は空・真偽値・数値。区切りと引用符・前後の空白は引用する', () => {
    const csv = toCsv({ columns: ['id', 'name', 'ok'], rows: [[1, 'a,b', true], [null, 'say "hi"', false], [2.5, ' pad', 'x\r\ny'], [3, '***', null]] });
    expect(csv).toBe('\uFEFFid,name,ok\r\n1,"a,b",true\r\n,"say ""hi""",false\r\n2.5," pad","x\r\ny"\r\n3,***,');
    expect(parseTable('{"columns":["a"],"rows":[[1]]}')).toEqual({ columns: ['a'], rows: [[1]] });
    expect(parseTable('{"a":1}')).toBeNull();
    expect(parseTable('not json')).toBeNull();
  });
});

describe('一覧の行の操作（DD-EVTRACE-EVROW）', () => {
  it('[DD-EVTRACE-EVROW-P001][DD-EVTRACE-EVROW-T001][DD-EVTRACE-EVROW-T002] skipped は開く・保存を出さない（対象外（only の指定））', () => {
    expect(rowAction(rec(1, { status: 'skipped', files: [] }))).toEqual({ kind: 'none', note: '対象外（only の指定）' });
  });

  it('[DD-EVTRACE-EVROW-P002][DD-EVTRACE-EVROW-T003] warn・failed は開くで理由を広げる（もう一度で閉じる。1 行に 1 つ）', () => {
    for (const status of ['warn', 'failed'] as const) expect(rowAction(rec(1, { status, reason: 'app-log（判定後）— 終了コード 1' }))).toEqual({ kind: 'expand', text: '取得に失敗しました：app-log（判定後）— 終了コード 1' });
    expect(toggleExpanded(null, 3)).toBe(3);
    expect(toggleExpanded(3, 3)).toBeNull();
    expect(toggleExpanded(3, 2)).toBe(2);
  });

  it('[DD-EVTRACE-EVROW-P003][DD-EVTRACE-EVROW-T004][DD-EVTRACE-EVROW-T005] ok ですべて omitted なら理由を広げる・保存は出さない', () => {
    expect(rowAction(rec(1, { files: [file('a.png', 'image', 'too-large')] }))).toEqual({ kind: 'expand', text: '大きすぎるため保存していません' });
    expect(rowAction(rec(1, { files: [file('a.png', 'image', 'branch-limit'), file('b.png', 'image', 'too-large')] }))).toEqual({ kind: 'expand', text: '結果ブランチに置いていません・大きすぎるため保存していません' });
  });

  it('[DD-EVTRACE-EVROW-P004][DD-EVTRACE-EVROW-T006] ok で読めるファイルがあればダイアログ・保存', () => {
    expect(rowAction(rec(1, { files: [file('a.png', 'image', 'too-large'), file('b.png')] }))).toEqual({ kind: 'dialog' });
  });

  it('一覧の列：種類・取得手段・タイムラインの印', () => {
    expect(kindLabel(rec(1, { files: [file('t.table.json', 'table')], totalRows: 3 }))).toBe('表（3 行）');
    expect(kindLabel(rec(1, { files: [file('t.table.json', 'table')] }))).toBe('表');
    expect(kindLabel(rec(1, { files: [file('a.zip', 'file')] }))).toBe('ファイル（zip）');
    expect(kindLabel(rec(1, { files: [file('a.txt', 'text')] }))).toBe('テキスト');
    expect(kindLabel(rec(1, { files: [] }))).toBe('—');
    expect(useLabel({ use: 'db', provider: 'builtin', db: { name: 'app', type: 'sqlite' } })).toBe('db（app・sqlite）');
    expect(useLabel({ use: 'app-log', provider: 'command' })).toBe('app-log（コマンド）');
    expect(useLabel({ use: 'orders', provider: 'hooks' })).toBe('orders（hooks）');
    expect(stepMarks([rec(1), rec(2, { status: 'skipped' })])).toEqual({ count: 1, warn: false });
    expect(stepMarks([rec(1), rec(2, { status: 'failed' })])).toEqual({ count: 2, warn: true });
    expect(stepMarks([rec(1, { status: 'skipped' })])).toBeNull();
    expect(stepMarks(undefined)).toBeNull();
  });
});

describe('ダイアログの状態（DD-EVTRACE-EVDLG）', () => {
  const blob = new Blob(['x']);
  const t1 = { seq: 1, file: 0 };
  const t2 = { seq: 2, file: 0 };
  type Ev = 'open' | 'loaded' | 'failed' | 'switch' | 'step' | 'save' | 'close';
  const ev = (s: DialogState, e: Ev): DialogEvent =>
    e === 'open' ? { type: 'open', target: t1 } : e === 'loaded' ? { type: 'loaded', token: s.token, blob } : e === 'failed' ? { type: 'failed', token: s.token, error: '古い実行のため証跡は削除されました' } : e === 'switch' ? { type: 'switch', target: t2 } : e === 'step' ? { type: 'step', target: t2 } : { type: e };
  const walk = (events: Ev[]) => {
    let s = DIALOG_CLOSED;
    const phases: string[] = [];
    for (const e of events) {
      s = reduceDialog(s, ev(s, e));
      phases.push(s.phase);
    }
    return phases;
  };

  it('[DD-EVTRACE-EVDLG-P001] 経路 [open, loaded, switch, loaded, close]', () => {
    expect(walk(['open', 'loaded', 'switch', 'loaded', 'close'])).toEqual(['loading', 'shown', 'loading', 'shown', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P002] 経路 [open, loaded, switch, failed, close]', () => {
    expect(walk(['open', 'loaded', 'switch', 'failed', 'close'])).toEqual(['loading', 'shown', 'loading', 'failed', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P003] 経路 [open, loaded, switch, close]', () => {
    expect(walk(['open', 'loaded', 'switch', 'close'])).toEqual(['loading', 'shown', 'loading', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P004] 経路 [open, loaded, save, switch, failed, close]', () => {
    expect(walk(['open', 'loaded', 'save', 'switch', 'failed', 'close'])).toEqual(['loading', 'shown', 'shown', 'loading', 'failed', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P005] 経路 [open, loaded, save, switch, close]', () => {
    expect(walk(['open', 'loaded', 'save', 'switch', 'close'])).toEqual(['loading', 'shown', 'shown', 'loading', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P006] 経路 [open, loaded, save, close]', () => {
    expect(walk(['open', 'loaded', 'save', 'close'])).toEqual(['loading', 'shown', 'shown', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P007] 経路 [open, loaded, close]', () => {
    expect(walk(['open', 'loaded', 'close'])).toEqual(['loading', 'shown', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P008] 経路 [open, failed, step, loaded, save, close]', () => {
    expect(walk(['open', 'failed', 'step', 'loaded', 'save', 'close'])).toEqual(['loading', 'failed', 'loading', 'shown', 'shown', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P009] 経路 [open, failed, step, loaded, close]', () => {
    expect(walk(['open', 'failed', 'step', 'loaded', 'close'])).toEqual(['loading', 'failed', 'loading', 'shown', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P010] 経路 [open, failed, step, failed, close]', () => {
    expect(walk(['open', 'failed', 'step', 'failed', 'close'])).toEqual(['loading', 'failed', 'loading', 'failed', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P011] 経路 [open, failed, step, close]', () => {
    expect(walk(['open', 'failed', 'step', 'close'])).toEqual(['loading', 'failed', 'loading', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P012] 経路 [open, failed, close]', () => {
    expect(walk(['open', 'failed', 'close'])).toEqual(['loading', 'failed', 'closed']);
  });

  it('[DD-EVTRACE-EVDLG-P013] 経路 [open, close]', () => {
    expect(walk(['open', 'close'])).toEqual(['loading', 'closed']);
  });


  it('[DD-EVTRACE-EVDLG-T001][DD-EVTRACE-EVDLG-T002][DD-EVTRACE-EVDLG-T003][DD-EVTRACE-EVDLG-T004][DD-EVTRACE-EVDLG-T005][DD-EVTRACE-EVDLG-T006][DD-EVTRACE-EVDLG-T007][DD-EVTRACE-EVDLG-T008][DD-EVTRACE-EVDLG-T009] 遷移ごとの状態・保存の可否', () => {
    const loading = reduceDialog(DIALOG_CLOSED, { type: 'open', target: t1 });
    expect(loading).toMatchObject({ phase: 'loading', target: t1 });
    const shown = reduceDialog(loading, { type: 'loaded', token: loading.token, blob });
    expect(shown).toMatchObject({ phase: 'shown', blob });
    expect(canSave(shown)).toBe(true);
    const failed = reduceDialog(loading, { type: 'failed', token: loading.token, error: 'E' });
    expect(failed).toMatchObject({ phase: 'failed', error: 'E' });
    expect(canSave(failed)).toBe(false);
    expect(canSave(loading)).toBe(false);
    expect(reduceDialog(shown, { type: 'switch', target: { seq: 1, file: 1 } })).toMatchObject({ phase: 'loading', target: { seq: 1, file: 1 } });
    expect(reduceDialog(failed, { type: 'step', target: t2 })).toMatchObject({ phase: 'loading', target: t2 });
    expect(reduceDialog(shown, { type: 'save' })).toBe(shown);
    for (const s of [shown, failed, loading]) expect(reduceDialog(s, { type: 'close' }).phase).toBe('closed');
  });

  it('[DD-EVTRACE-EVDLG-X001][DD-EVTRACE-EVDLG-X002][DD-EVTRACE-EVDLG-X003][DD-EVTRACE-EVDLG-X004][DD-EVTRACE-EVDLG-X005][DD-EVTRACE-EVDLG-X006][DD-EVTRACE-EVDLG-X007][DD-EVTRACE-EVDLG-X008][DD-EVTRACE-EVDLG-X009][DD-EVTRACE-EVDLG-X010] 当てはまらない操作は状態を変えない', () => {
    const loading = reduceDialog(DIALOG_CLOSED, { type: 'open', target: t1 });
    const shown = reduceDialog(loading, { type: 'loaded', token: loading.token, blob });
    const failed = reduceDialog(loading, { type: 'failed', token: loading.token, error: 'E' });
    const cases: Array<[DialogState, DialogEvent]> = [
      [loading, { type: 'switch', target: t2 }],
      [loading, { type: 'step', target: t2 }],
      [loading, { type: 'save' }],
      [shown, { type: 'loaded', token: shown.token, blob }],
      [shown, { type: 'failed', token: shown.token, error: 'E' }],
      [shown, { type: 'step', target: t2 }],
      [failed, { type: 'loaded', token: failed.token, blob }],
      [failed, { type: 'failed', token: failed.token, error: 'E2' }],
      [failed, { type: 'switch', target: t2 }],
      [failed, { type: 'save' }],
    ];
    for (const [s, e] of cases) expect(reduceDialog(s, e)).toBe(s);
    // A stale result (closed or moved on while loading) is dropped.
    const next = reduceDialog(reduceDialog(shown, { type: 'switch', target: t2 }), { type: 'loaded', token: loading.token, blob });
    expect(next.phase).toBe('loading');
    const closed = reduceDialog(loading, { type: 'close' });
    expect(reduceDialog(closed, { type: 'loaded', token: loading.token, blob })).toBe(closed);
  });

  it('次の証跡・前の証跡は ok で読めるファイルを持つ証跡だけを順に回る', () => {
    const records = [rec(1), rec(2, { status: 'warn' }), rec(3, { files: [file('x', 'image', 'too-large')] }), rec(4), rec(5, { status: 'skipped', files: [] })];
    expect(stepTarget(records, 1, 1)).toBe(4);
    expect(stepTarget(records, 4, 1)).toBe(1);
    expect(stepTarget(records, 1, -1)).toBe(4);
    expect(stepTarget([rec(1)], 1, 1)).toBe(1);
    const loading = reduceDialog(DIALOG_CLOSED, { type: 'open', target: t1 });
    const shown = reduceDialog(loading, { type: 'loaded', token: loading.token, blob });
    const failed = reduceDialog(loading, { type: 'failed', token: loading.token, error: 'E' });
    expect(moveEvent(shown, records, 1)).toEqual({ type: 'switch', target: { seq: 4, file: 0 } });
    expect(moveEvent(failed, records, -1)).toEqual({ type: 'step', target: { seq: 4, file: 0 } });
    expect(moveEvent(loading, records, 1)).toBeNull();
  });

  it('注記：伏せた列・行数・切り詰め・置いていないファイル', () => {
    const t = rec(2, { use: 'db', files: [file('t.table.json', 'table')], masked: ['card_no'], totalRows: 1 });
    expect(evidenceNote(t, { writtenRows: 1 })).toBe('card_no は伏せています。1 行中 1 行を表示。');
    expect(evidenceNote(rec(2, { files: [file('t.table.json', 'table')], totalRows: 201 }), { writtenRows: 200 })).toBe('200 行以上のうち 200 行を表示。');
    expect(evidenceNote(rec(2, { files: [file('t.table.json', 'table')], totalRows: 900, truncated: true }), { writtenRows: 10 })).toBe('900 行中 10 行を表示。');
    expect(evidenceNote(rec(3, { files: [file('a.txt', 'text'), file('b.txt', 'text', 'branch-limit')], truncated: true }))).toBe('上限の大きさで切っています。1 個のファイルは 結果ブランチに置いていない ため表示できません。');
    expect(evidenceNote(rec(1))).toBeNull();
  });
});

describe('保存（DD-EVTRACE-EVSAVE）', () => {
  const deps = () => {
    const log: string[] = [];
    let saved: Blob | null = null;
    return {
      log,
      saved: () => saved,
      d: {
        createUrl: (b: Blob) => ((saved = b), 'blob:1'),
        revokeUrl: (u: string) => log.push(`revoke ${u}`),
        click: (href: string, name: string) => log.push(`click ${href} ${name}`),
      },
    };
  };

  it('[DD-EVTRACE-EVSAVE-P001][DD-EVTRACE-EVSAVE-T001][DD-EVTRACE-EVSAVE-T002][DD-EVTRACE-EVSAVE-T004] 表は CSV にして .table.json を .csv に。保存の後に URL を破棄する', async () => {
    const x = deps();
    const name = await saveEvidence(file('1-2-orders.table.json', 'table'), new Blob(['{"columns":["id"],"rows":[[1]]}']), x.d);
    expect(name).toBe('1-2-orders.csv');
    expect([...new Uint8Array(await x.saved()!.arrayBuffer())]).toEqual([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('id\r\n1')]);
    expect(x.saved()!.type).toBe('text/csv;charset=utf-8');
    await new Promise((r) => setTimeout(r, 1));
    expect(x.log).toEqual(['click blob:1 1-2-orders.csv', 'revoke blob:1']);
  });

  it('[DD-EVTRACE-EVSAVE-P002][DD-EVTRACE-EVSAVE-T003][DD-EVTRACE-EVSAVE-T005] 表以外は取得した Blob のまま、名前は path の最後', async () => {
    for (const [n, k] of [['1-1-shot.png', 'image'], ['a.json', 'json'], ['log.txt', 'text'], ['dump.zip', 'file']] as const) {
      const x = deps();
      const b = new Blob(['body']);
      expect(saveName(file(n, k))).toBe(n);
      expect(await saveEvidence(file(n, k), b, x.d)).toBe(n);
      expect(x.saved()).toBe(b);
      await new Promise((r) => setTimeout(r, 1));
      expect(x.log).toEqual([`click blob:1 ${n}`, 'revoke blob:1']);
    }
  });
});

describe('件数の印（DD-EVTRACE-EVBADGE）', () => {
  it('[DD-EVTRACE-EVBADGE-P001][DD-EVTRACE-EVBADGE-T001][DD-EVTRACE-EVBADGE-T002] 0・無しは出さない', () => {
    expect(evidenceBadge({})).toBeNull();
    expect(evidenceBadge({ web: {} })).toBeNull();
    expect(evidenceBadge({ web: { evidence: 0 } })).toBeNull();
  });

  it('[DD-EVTRACE-EVBADGE-P002][DD-EVTRACE-EVBADGE-T003][DD-EVTRACE-EVBADGE-T004] 警告があれば警告の色で「証跡 n・警告 m」', () => {
    expect(evidenceBadge({ web: { evidence: 3, evidenceWarnings: 1 } })).toEqual({ text: '証跡 3・警告 1', warn: true });
  });

  it('[DD-EVTRACE-EVBADGE-P003][DD-EVTRACE-EVBADGE-T005] 警告が無ければ通常の色で「証跡 n」。プラットフォーム別なら合計と内訳', () => {
    expect(evidenceBadge({ web: { evidence: 2 } })).toEqual({ text: '証跡 2', warn: false });
    expect(evidenceBadge({ web: { evidence: 2 }, wpf: { evidence: 1, evidenceWarnings: 1 }, winforms: {} })).toEqual({ text: '証跡 3・警告 1', warn: true, title: 'web：証跡 2\nwpf：証跡 1・警告 1' });
  });
});
