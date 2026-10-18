import { mkdtempSync, promises as fs, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cutUtf8, evidenceName, EvidenceStore, SAVE_ERROR } from './store.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ddv-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = (limits = { maxBytes: 1024, maxFileBytes: 1024 }) => new EvidenceStore(dir, 'SCN-1@web', limits);
const read = (rel: string) => readFileSync(path.join(dir, ...rel.split('/')), 'utf8');

describe('ファイル名（FNAME）', () => {
  it('[DD-EVTRACE-FNAME-P003][DD-EVTRACE-FNAME-P004][DD-EVTRACE-FNAME-T001][DD-EVTRACE-FNAME-T002][DD-EVTRACE-FNAME-T003][DD-EVTRACE-FNAME-T005][DD-EVTRACE-FNAME-T007] 使えない文字を _ に・前後の空白と末尾のピリオドを除き 40 文字まで', () => {
    expect(evidenceName(' a\\b/c:d*e?f"g<h>i|j\u0001k. ', 'db')).toBe('a_b_c_d_e_f_g_h_i_j_k');
    expect(evidenceName('注文'.repeat(30), 'db')).toBe('注文'.repeat(20));
    expect(Array.from(evidenceName('😀'.repeat(50), 'db'))).toHaveLength(40);
    expect(evidenceName('nul', 'db')).toBe('_nul');
  });

  it('[DD-EVTRACE-FNAME-P001][DD-EVTRACE-FNAME-P002][DD-EVTRACE-FNAME-T004][DD-EVTRACE-FNAME-T006] 空なら use を同じ規則で使う', () => {
    expect(evidenceName(' ... ', 'db:main')).toBe('db_main');
    expect(evidenceName('', 'screenshot')).toBe('screenshot');
  });

  it('[DD-EVTRACE-FNAME-T008][DD-EVTRACE-FNAME-T009] 出力が 1 つなら step-seq-名前、2 つ以上なら -k を付ける', async () => {
    const one = await store().save(3, 2, '注文の表', 'db', [{ kind: 'text', text: 'a' }]);
    expect(one.files.map((f) => f.path)).toEqual(['SCN-1@web/evidence/3-2-注文の表.txt']);
    const two = await store().save(3, 4, '', 'logs', [{ kind: 'text', text: 'a' }, { kind: 'json', data: { b: 1 } }]);
    expect(two.files.map((f) => f.path)).toEqual(['SCN-1@web/evidence/3-4-logs-1.txt', 'SCN-1@web/evidence/3-4-logs-2.json']);
    expect(await fs.readdir(path.join(dir, 'SCN-1@web', 'evidence'))).not.toContain(expect.stringMatching(/\.tmp$/));
  });

  it('書けなかったら「証跡を保存できません」', async () => {
    writeFileSync(path.join(dir, 'SCN-1@web'), 'file, not a folder');
    await expect(store().save(1, 1, 'a', 'a', [{ kind: 'text', text: 'x' }])).rejects.toThrow(SAVE_ERROR);
  });
});

describe('大きさの上限（SAVESIZE）', () => {
  it('[DD-EVTRACE-SAVESIZE-P001][DD-EVTRACE-SAVESIZE-T001][DD-EVTRACE-SAVESIZE-T002][DD-EVTRACE-SAVESIZE-T003] 表が maxBytes 以下ならそのまま', async () => {
    const r = await store().save(1, 1, 't', 'db', [{ kind: 'table', columns: ['a', 'b'], rows: [[1, 'x'], [null, true]] }]);
    expect(r.truncated).toBe(false);
    expect(r.files[0]).toMatchObject({ kind: 'table', mime: 'application/json', path: 'SCN-1@web/evidence/1-1-t.table.json' });
    expect(JSON.parse(read(r.files[0].path))).toEqual({ columns: ['a', 'b'], rows: [[1, 'x'], [null, true]] });
  });

  it('[DD-EVTRACE-SAVESIZE-P002][DD-EVTRACE-SAVESIZE-T004] 表が超えたら後ろの行から除く', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => [i, 'x'.repeat(20)]);
    const r = await store().save(1, 1, 't', 'db', [{ kind: 'table', columns: ['n', 's'], rows }]);
    expect(r.truncated).toBe(true);
    const body = read(r.files[0].path);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024);
    const kept = JSON.parse(body).rows as unknown[][];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(rows.slice(0, kept.length));
    expect(JSON.stringify({ columns: ['n', 's'], rows: rows.slice(0, kept.length + 1) }).length).toBeGreaterThan(1024);
  });

  it('[DD-EVTRACE-SAVESIZE-P003][DD-EVTRACE-SAVESIZE-T005][DD-EVTRACE-SAVESIZE-T006] テキストが以下ならそのまま（外部コマンドの .log は拡張子を保つ）', async () => {
    const r = await store().save(1, 1, 'log', 'cmd', [{ kind: 'text', text: 'あいう', ext: 'log' }]);
    expect(r.files[0]).toMatchObject({ kind: 'text', mime: 'text/plain', bytes: 9, path: 'SCN-1@web/evidence/1-1-log.log' });
    expect(r.truncated).toBe(false);
  });

  it('[DD-EVTRACE-SAVESIZE-P004][DD-EVTRACE-SAVESIZE-T007] テキストが超えたら文字の途中で切らずに切る', async () => {
    const r = await store().save(1, 1, 'log', 'cmd', [{ kind: 'text', text: 'あ'.repeat(400) }]);
    expect(r.truncated).toBe(true);
    expect(read(r.files[0].path)).toBe('あ'.repeat(341));
    expect(cutUtf8('aあ', 2)).toEqual({ text: 'a', cut: true });
  });

  it('[DD-EVTRACE-SAVESIZE-P005][DD-EVTRACE-SAVESIZE-T008][DD-EVTRACE-SAVESIZE-T009] JSON が以下なら整形して書く', async () => {
    const r = await store().save(1, 1, 'j', 'h', [{ kind: 'json', data: { a: [1] } }]);
    expect(r.files[0]).toMatchObject({ kind: 'json', mime: 'application/json' });
    expect(read(r.files[0].path)).toBe(JSON.stringify({ a: [1] }, null, 2));
  });

  it('[DD-EVTRACE-SAVESIZE-P006][DD-EVTRACE-SAVESIZE-T010] JSON が超えたら kind=text として切る', async () => {
    const r = await store().save(1, 1, 'j', 'h', [{ kind: 'json', data: { a: 'x'.repeat(2000) } }]);
    expect(r.truncated).toBe(true);
    expect(r.files[0]).toMatchObject({ kind: 'text', mime: 'text/plain', bytes: 1024, path: 'SCN-1@web/evidence/1-1-j.txt' });
  });

  it('[DD-EVTRACE-SAVESIZE-P007][DD-EVTRACE-SAVESIZE-T011][DD-EVTRACE-SAVESIZE-T012] 画像・ファイルが maxFileBytes 以下ならコピー（png 以外の画像の種類・拡張子なしは .bin）', async () => {
    const png = path.join(dir, 'shot.PNG');
    writeFileSync(png, Buffer.alloc(100, 1));
    const svg = path.join(dir, 'a.svg');
    writeFileSync(svg, '<svg/>');
    const bin = path.join(dir, 'raw');
    writeFileSync(bin, 'x');
    const r = await store().save(2, 1, 'shot', 'screenshot', [{ kind: 'image', path: png }, { kind: 'image', path: svg }, { kind: 'file', path: bin }]);
    expect(r.files).toEqual([
      { path: 'SCN-1@web/evidence/2-1-shot-1.png', kind: 'image', mime: 'image/png', bytes: 100 },
      { path: 'SCN-1@web/evidence/2-1-shot-2.svg', kind: 'file', mime: 'application/octet-stream', bytes: 6 },
      { path: 'SCN-1@web/evidence/2-1-shot-3.bin', kind: 'file', mime: 'application/octet-stream', bytes: 1 },
    ]);
    expect(read(r.files[1].path)).toBe('<svg/>');
  });

  it('[DD-EVTRACE-SAVESIZE-P008][DD-EVTRACE-SAVESIZE-T013] 超えたら本体を書かず omitted=too-large（bytes は元の大きさ）', async () => {
    const png = path.join(dir, 'big.png');
    writeFileSync(png, Buffer.alloc(5000));
    const r = await store().save(1, 1, 'shot', 'screenshot', [{ kind: 'image', path: png }]);
    expect(r.files).toEqual([{ path: 'SCN-1@web/evidence/1-1-shot.png', kind: 'image', mime: 'image/png', bytes: 5000, omitted: 'too-large' }]);
    expect(r.truncated).toBe(false);
    await expect(fs.stat(path.join(dir, 'SCN-1@web', 'evidence', '1-1-shot.png'))).rejects.toThrow();
  });
});
