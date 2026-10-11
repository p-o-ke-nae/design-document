---
name: ddv-detailed-design
description: 承認済みの ddv 基本設計から詳細設計（クラス図、シーケンス図、クラス/関数単位の状態図による単体テストマトリクス）を作り、テストIDを採番して lint を通し、人間のレビュー待ちまで進める。詳細設計・内部設計・クラス設計の作成時に使う。
---

# ddv 詳細設計

入力：`status: approved` の基本設計（`docs/design/basic/*.md`）。承認前なら作業せず人間に確認する。
出力：`docs/design/detailed/<name>.md`、`.ddv/testids.lock.json`。

## 原則

- **UML/Mermaid が主、文章は最小限**。基本設計の内容は `:ref[...]` で参照し書き写さない
- front matter の `traces` に基本設計の文書コード（例 `BD-ORDER`）を書く
- 実装と1対1に対応する名前（クラス名・メソッド名・enum 値）を使う。実装時にそのまま使える粒度にする

## 作るもの

| 節 | 図・内容 | フェンスの属性 |
|---|---|---|
| 前提 | 対応する基本設計の節への `:ref[...]`（数行。内容は書き写さない） | — |
| 画面（画面がある場合） | 基本設計のモックを `::mock[<name>/index.html]` で埋め込み（表示だけ）、**画面項目詳細** の表（項目 / testid / 種類 / 型・桁 / 必須 / 初期値 / 取得元・送信先 / 入力チェック・エラー文言） | — |
| 構造 | classDiagram（責務・依存の向き、enum） | `id=class` |
| 振る舞い | sequenceDiagram（クラス間の呼び出し） | `id=...` |
| 状態 | クラス/関数単位の stateDiagram-v2 | `id=... code=<略号> matrix`（単体テストは通常 `nswitch=0`） |
| 分岐の多い関数 | flowchart（判定ノード＝ひし形） | `id=... code=<略号> matrix` |

- `matrix` 付きの図から生成されるIDがそのまま **単体テストのID** になる
- 不正遷移（X）の期待動作（例外・無視など）は図の下に1行で書く
- 画面イメージの正本は基本設計のモック。詳細設計にモックをコピーしたり画像を貼ったりしない（`::mock` で同じモックを埋め込む。シナリオ・経路との対応は基本設計側が持つ）
- 画面項目詳細の testid はモックの `data-testid` と同じ値にする（実装・E2E でも同じ値を使う）

## モックの疑似API・テストデータ

基本設計のモック（`docs/mocks/<name>/`）に、API 設計に合わせた疑似 API とテストデータを足す。サーバ不要でモックが実データ風に動く。

- `api.yaml`：テーブルとルート（`op: list / get / insert / update`、`when` の条件付きエラー応答）。**条件式を書けるのはこのファイルだけ**
- `fixtures/default.yaml` ほか：テーブル名 → 行の配列。シナリオの `fixtures: [default, ...]` で指定した順に重ねて DB を初期化する。人間も保守するので値だけを書く
- 宣言で書けない振る舞いだけ `mock.js`（`mock.on` / `mock.route`）
- 詳細設計 md の API シーケンス図・ER 図とルート・テーブル名をそろえる
- 変更後はプレイヤーで全シナリオを再生し、`ddv-lint` の warning（モック・シナリオ）を 0 にする
- テンプレート：`../../templates/docs/mocks/sample/api.yaml`、`fixtures/default.yaml`

## 手順

1. テンプレート `../../templates/docs/design/detailed/sample.md` を元に書く
2. `npm --prefix "$DDV_HOME" run ddv-testid -- generate --repo <repo>`
3. `npm --prefix "$DDV_HOME" run ddv-lint -- --repo <repo>` を error 0 まで
4. `status: review` にして、人間に ddv での確認を依頼する（追加した図、テストID数、迷った点）
5. 承認されたら `status: approved`

## 実装工程への引き継ぎ（テストとの紐づけ規約）

実装ではテストIDをテストに書くと ddv が自動で紐づけ、ビューアから実行できるようになる。

| フレームワーク | 書き方 |
|---|---|
| Vitest / Jest | `it('[DD-ORDER-STATUS-T001] 申請できる', ...)` |
| Playwright | `test('[BD-ORDER-SCREEN-P001] ...', ...)` |
| xUnit | `[Trait("TestId", "DD-ORDER-STATUS-T001")]` |
| NUnit / MSTest | `[Property("TestId", "...")]` / `[TestProperty("TestId", "...")]` |

- ID一覧・内容：`npm --prefix "$DDV_HOME" run ddv-testid -- list --repo <repo>` / `show <id>`
- 網羅確認：`npm --prefix "$DDV_HOME" run ddv-testid -- check --repo <repo> --strict`（未実装ID・存在しないIDの参照を検出）

画面の経路（`BD-...-P/T/S/X`）の E2E は **テストコードを書かない**。`ddv mock init` が置く固定の `e2e/ddv-scenarios.spec.ts` がシナリオ YAML を読んで実行する（データ駆動）。
実アプリに向けるときに実装工程で用意するもの：

| ファイル | 内容 |
|---|---|
| `docs/mocks/<name>/scenarios/_map.yaml` | 実アプリの画面（`url` 正規表現 / `selector`）・イベント（セレクタ）・入力要素（既定は `[data-testid=キー]`）の対応表 |
| `e2e/ddv-hooks.ts`（任意） | `export const seed`（fixtures を実アプリの API/DB へ投入）、`export const steps`（シナリオの `do` の独自操作） |

実行：`DDV_BASE_URL=<実アプリのURL>` を付けて playwright ランナーを実行（未設定ならモックに対して実行）。
テンプレート：`../../templates/docs/mocks/sample/scenarios/_map.yaml`、`../../templates/e2e/ddv-hooks.ts`

## 禁止

- 承認済みの要件定義・基本設計を書き換えない（誤りを見つけたら人間に差し戻しを提案する）
- `.ddv/testids.lock.json` を手で編集しない
