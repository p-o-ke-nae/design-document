import { describe, expect, it } from 'vitest';
import { checkSql, rewriteSql, sqlParams } from './sql-guard.ts';

const ok = (sql: string) => expect(checkSql(sql)).toEqual({ ok: true });
const bad = (sql: string, reason: string) => expect(checkSql(sql)).toEqual({ ok: false, reason });
const UNCLOSED = 'SQL の文字列かコメントが閉じていません';
const DELETE = '読み取りでない文は実行しない（DELETE）';

describe('SQL の字句（SQLLEX）', () => {
  it('[DD-EVRUN-SQLLEX-P001][DD-EVRUN-SQLLEX-T001][DD-EVRUN-SQLLEX-T002][DD-EVRUN-SQLLEX-T003][DD-EVRUN-SQLLEX-T010] 文字列の中の語は数えず 単一引用符 2 つは文字列のまま', () => {
    ok("SELECT 'it''s DELETE' AS a");
    bad("SELECT 'a' AS b; DELETE", '複数の文は実行しない');
  });

  it('[DD-EVRUN-SQLLEX-P002][DD-EVRUN-SQLLEX-T004][DD-EVRUN-SQLLEX-T005] 二重引用符・角かっこの名前の中の語は数えない', () => {
    ok('SELECT "Delete", [Update] FROM t');
    bad('SELECT [a] DELETE', DELETE);
  });

  it('[DD-EVRUN-SQLLEX-P003][DD-EVRUN-SQLLEX-T006][DD-EVRUN-SQLLEX-T007] 行コメントは改行で終わる', () => {
    ok('SELECT 1 -- DELETE\nFROM t');
    bad('SELECT 1 -- x\nDELETE', DELETE);
  });

  it('[DD-EVRUN-SQLLEX-P004][DD-EVRUN-SQLLEX-T008][DD-EVRUN-SQLLEX-T009] ブロックコメントはアスタリスクとスラッシュで終わる', () => {
    ok('SELECT /* DELETE */ 1');
    bad('SELECT /* x */ DELETE', DELETE);
  });

  it('[DD-EVRUN-SQLLEX-P005] 通常のまま終わる', () => ok('SELECT 1'));

  // Invalid transitions: the event has no effect in that state (the state continues).
  const noEffect: Array<[string, string, string, boolean]> = [
    ['DD-EVRUN-SQLLEX-X001', '通常 で 2 つの単一引用符', "SELECT '' DELETE", false],
    ['DD-EVRUN-SQLLEX-X002', '通常 で 閉じのかっこ', 'SELECT a] DELETE', false],
    ['DD-EVRUN-SQLLEX-X003', '通常 で 改行', 'SELECT 1\nDELETE', false],
    ['DD-EVRUN-SQLLEX-X004', '通常 で */', 'SELECT 1 */ DELETE', false],
    ['DD-EVRUN-SQLLEX-X005', '文字列 で 単一引用符 2 つ', "SELECT 'a'' DELETE'", true],
    ['DD-EVRUN-SQLLEX-X006', '文字列 で 二重引用符・角かっこ', `SELECT 'a" [ DELETE'`, true],
    ['DD-EVRUN-SQLLEX-X007', '文字列 で 閉じのかっこ', "SELECT 'a] DELETE'", true],
    ['DD-EVRUN-SQLLEX-X008', '文字列 で ハイフン 2 つ', "SELECT 'a -- DELETE'", true],
    ['DD-EVRUN-SQLLEX-X009', '文字列 で 改行', "SELECT 'a\nDELETE'", true],
    ['DD-EVRUN-SQLLEX-X010', '文字列 で /*', "SELECT 'a /* DELETE'", true],
    ['DD-EVRUN-SQLLEX-X011', '文字列 で */', "SELECT 'a */ DELETE'", true],
    ['DD-EVRUN-SQLLEX-X013', '引用の名前 で 単一引用符', `SELECT "a' DELETE"`, true],
    ['DD-EVRUN-SQLLEX-X014', '引用の名前 で 単一引用符 2 つ', `SELECT "a'' DELETE"`, true],
    ['DD-EVRUN-SQLLEX-X015', '引用の名前 で 角かっこの開き', 'SELECT "a[ DELETE"', true],
    ['DD-EVRUN-SQLLEX-X016', '引用の名前 で ハイフン 2 つ', 'SELECT "a -- DELETE"', true],
    ['DD-EVRUN-SQLLEX-X017', '引用の名前 で 改行', 'SELECT [a\nDELETE]', true],
    ['DD-EVRUN-SQLLEX-X018', '引用の名前 で /*', 'SELECT [a /* DELETE]', true],
    ['DD-EVRUN-SQLLEX-X019', '引用の名前 で */', 'SELECT [a */ DELETE]', true],
    ['DD-EVRUN-SQLLEX-X021', '行コメント で 単一引用符', "SELECT 1 -- ' DELETE\n", true],
    ['DD-EVRUN-SQLLEX-X022', '行コメント で 単一引用符 2 つ', "SELECT 1 -- '' DELETE\n", true],
    ['DD-EVRUN-SQLLEX-X023', '行コメント で 二重引用符', 'SELECT 1 -- " DELETE\n', true],
    ['DD-EVRUN-SQLLEX-X024', '行コメント で 閉じのかっこ', 'SELECT 1 -- ] DELETE\n', true],
    ['DD-EVRUN-SQLLEX-X025', '行コメント で ハイフン 2 つ', 'SELECT 1 -- -- DELETE\n', true],
    ['DD-EVRUN-SQLLEX-X026', '行コメント で /*', 'SELECT 1 -- /* DELETE\n', true],
    ['DD-EVRUN-SQLLEX-X027', '行コメント で */', 'SELECT 1 -- */ DELETE\n', true],
    ['DD-EVRUN-SQLLEX-X029', 'ブロックコメント で 単一引用符', "SELECT 1 /* ' DELETE */", true],
    ['DD-EVRUN-SQLLEX-X030', 'ブロックコメント で 単一引用符 2 つ', "SELECT 1 /* '' DELETE */", true],
    ['DD-EVRUN-SQLLEX-X031', 'ブロックコメント で 二重引用符', 'SELECT 1 /* " DELETE */', true],
    ['DD-EVRUN-SQLLEX-X032', 'ブロックコメント で 閉じのかっこ', 'SELECT 1 /* ] DELETE */', true],
    ['DD-EVRUN-SQLLEX-X033', 'ブロックコメント で ハイフン 2 つ', 'SELECT 1 /* -- DELETE */', true],
    ['DD-EVRUN-SQLLEX-X034', 'ブロックコメント で 改行', 'SELECT 1 /* \n DELETE */', true],
    ['DD-EVRUN-SQLLEX-X035', 'ブロックコメント で /*（入れ子にしない）', 'SELECT 1 /* /* DELETE */', true],
  ];
  it('[DD-EVRUN-SQLLEX-X001][DD-EVRUN-SQLLEX-X002][DD-EVRUN-SQLLEX-X003][DD-EVRUN-SQLLEX-X004][DD-EVRUN-SQLLEX-X005][DD-EVRUN-SQLLEX-X006][DD-EVRUN-SQLLEX-X007][DD-EVRUN-SQLLEX-X008][DD-EVRUN-SQLLEX-X009][DD-EVRUN-SQLLEX-X010][DD-EVRUN-SQLLEX-X011][DD-EVRUN-SQLLEX-X013][DD-EVRUN-SQLLEX-X014][DD-EVRUN-SQLLEX-X015][DD-EVRUN-SQLLEX-X016][DD-EVRUN-SQLLEX-X017][DD-EVRUN-SQLLEX-X018][DD-EVRUN-SQLLEX-X019][DD-EVRUN-SQLLEX-X021][DD-EVRUN-SQLLEX-X022][DD-EVRUN-SQLLEX-X023][DD-EVRUN-SQLLEX-X024][DD-EVRUN-SQLLEX-X025][DD-EVRUN-SQLLEX-X026][DD-EVRUN-SQLLEX-X027][DD-EVRUN-SQLLEX-X029][DD-EVRUN-SQLLEX-X030][DD-EVRUN-SQLLEX-X031][DD-EVRUN-SQLLEX-X032][DD-EVRUN-SQLLEX-X033][DD-EVRUN-SQLLEX-X034][DD-EVRUN-SQLLEX-X035] 状態に無い事象は状態を変えない', () => {
    for (const [id, , sql, accepted] of noEffect) {
      expect(checkSql(sql), id).toEqual(accepted ? { ok: true } : { ok: false, reason: DELETE });
    }
  });

  it('[DD-EVRUN-SQLLEX-X012][DD-EVRUN-SQLLEX-X020][DD-EVRUN-SQLLEX-X036] 文字列・引用の名前・ブロックコメントのまま終わると失敗', () => {
    bad("SELECT 'abc", UNCLOSED);
    bad('SELECT "abc', UNCLOSED);
    bad('SELECT [abc', UNCLOSED);
    bad('SELECT 1 /* abc', UNCLOSED);
  });

  it('[DD-EVRUN-SQLLEX-X028] 行コメントのまま終わっても閉じていない扱いにしない', () => ok('SELECT 1 -- DELETE'));
});

describe('SELECT だけの検査（SQLGUARD）', () => {
  it('[BD-EVICAP-SQLGUARD-P001][BD-EVICAP-SQLGUARD-T001][BD-EVICAP-SQLGUARD-T002][BD-EVICAP-SQLGUARD-S001] 2 つ以上の文は失敗（末尾の ; と空白だけの文は数えない）', () => {
    bad('SELECT 1; SELECT 2', '複数の文は実行しない');
    ok('SELECT 1;  \n');
    ok("SELECT ';' AS semi -- ;");
  });

  it('[BD-EVICAP-SQLGUARD-P002][BD-EVICAP-SQLGUARD-T003][BD-EVICAP-SQLGUARD-T004][BD-EVICAP-SQLGUARD-S002][BD-EVICAP-SQLGUARD-S003] 先頭が SELECT・WITH でなければ失敗', () => {
    bad('DELETE FROM t', 'SELECT 以外の文は実行しない');
    bad('/* c */ update t set a = 1', 'SELECT 以外の文は実行しない');
  });

  it('[BD-EVICAP-SQLGUARD-P003][BD-EVICAP-SQLGUARD-T005][BD-EVICAP-SQLGUARD-T006][BD-EVICAP-SQLGUARD-S004][BD-EVICAP-SQLGUARD-S005] 更新・定義の語を含めば失敗（WITH … DELETE・SELECT INTO）', () => {
    bad('WITH x AS (SELECT 1) DELETE FROM t', DELETE);
    bad('select * into backup from t', '読み取りでない文は実行しない（INTO）');
  });

  it('[BD-EVICAP-SQLGUARD-T007][BD-EVICAP-SQLGUARD-S006] 含まなければ接続先へ進む（検査は通る）', () => {
    ok("WITH x AS (SELECT 1 AS a) SELECT a, 'DROP' FROM x");
  });

  it(':名前 の引数は通常の状態だけ・出現順・重複なし（:: の型変換は除く）', () => {
    expect(sqlParams("SELECT :b, :a, ':c', a::text, :b -- :d\n")).toEqual(['b', 'a']);
  });

  it('rewriteSql は ; を除き :名前 を各 DB の書き方にする', () => {
    expect(rewriteSql("SELECT :a, ':a', :b, :a;", (n, i) => `$${i}`)).toBe("SELECT $1, ':a', $2, $1");
    expect(rewriteSql('SELECT :id', (n) => `@${n}`)).toBe('SELECT @id');
  });
});
