---
name: ddv-basic-design
description: 承認済みの ddv 要件定義から基本設計（画面遷移の状態図、画面ごとの状態図/フロー図、外部I/Fのシーケンス図、ER図、モック）を作り、テストIDを採番して lint を通し、人間のレビュー待ちまで進める。基本設計・画面設計・外部設計の作成時に使う。
---

# ddv 基本設計

入力：`status: approved` の要件定義（`docs/design/requirements/*.md`）。承認前なら作業せず人間に確認する。
出力：`docs/design/basic/<name>.md`、`docs/mocks/<name>/`（`index.html`・`scenarios/`）、`.ddv/testids.lock.json`。

## 原則

- **UML/Mermaid が主、文章は最小限**。説明したくなったら図（状態図・シーケンス図・表）にできないか先に考える
- **二重管理しない**：要件の文言を書き写さず `:ref[../requirements/x.md#見出し]`（ポップアップ）か `::embed[...]`（転記表示）で参照する
- front matter の `traces` に対応する REQ-ID を全部書く。要件一覧のすべての REQ-ID がどこかの設計から trace されること

## 作るもの

| 節 | 図 | フェンスの属性 |
|---|---|---|
| 画面遷移 | stateDiagram-v2（状態＝画面、イベント＝操作、`[ガード]`＝条件） | `id=screen-flow code=SCREEN matrix` |
| 画面ごとの振る舞い（必要なら） | stateDiagram-v2 / flowchart | `id=... code=<略号> matrix` |
| 処理 | sequenceDiagram（利用者→画面→API→DB） | `id=...` |
| データ | erDiagram | `id=er` |
| 画面イメージ | `::mock[<name>/index.html]` | — |

- `matrix` を付けた図から **テストマトリクス（経路 P / 遷移 T / Nスイッチ S / 不正遷移 X）とテストID** が機械生成される。
  テストケースは手で書かない。網羅が足りなければ図（ガード・イベント）を直す
- 状態図は単純状態＋choice＋1段のネストまで。並行状態や fork は使わない（マトリクス非対応）
- イベント名はテストで操作として再現できる粒度（ボタン名・API 呼び出し）にする

## モック・シナリオ

規約の詳細は ddv の基本設計 `docs/design/basic/mock-player.md`（成果物・属性・疑似API・シナリオ）を正とする。

- 初回だけ `npm --prefix "$DDV_HOME" run ddv -- mock init --repo <repo>` で runtime（`docs/mocks/_ddv/mock-runtime.js`）と固定の E2E spec を配置する
- `docs/mocks/<name>/index.html`：**画面遷移図の全状態** を 1 ファイルに `section[data-screen="<状態ID>"]` で並べる（SPA 風。runtime が表示を切り替える）
  - 操作要素：`data-event="<図のイベント名（ガード除く）>"` と `data-testid`
  - 入力要素：`data-testid`、HTML 標準の制約（`required`/`min`/`max`/`maxlength`/`pattern`）、自然な候補値 `data-sample`
  - 振る舞いは宣言属性（`data-goto` / `data-validate` / `data-submit` / `data-bind`）で書く。足りない分だけ `mock.js`
  - `ddv.config.yaml` の `styles` にある **実プロジェクトの CSS を `<link>`** して見た目を合わせる
  - 末尾で `<script type="module" src="../_ddv/mock-runtime.js"></script>` を読む
- 疑似 API `api.yaml` とテストデータ `fixtures/default.yaml` を同じフォルダに置く（詳細は詳細設計スキル）
- シナリオは書かずに生成する：テストID採番の後に `npm --prefix "$DDV_HOME" run ddv -- mock scaffold --repo <repo>` → `scenarios/<テストID>.yaml`
  - 生成されたシナリオの `# 要確認` の値（入力値・期待値）を埋める。**式やスクリプトは書かない**（人間も保守するため）
  - 図を直したら再度 `scaffold`（編集した値は保持され、消えた経路は `scenarios/_retired/` へ）
- 実アプリにデスクトップ（WPF・WinForms）があるとき：シナリオは Web と共通に書く。プラットフォームだけの補助ステップ（例：ダイアログを閉じる）は `only: [wpf]` を付けて足す（`mock scaffold` で再生成しても保たれる）。`event` は補助ステップでは省ける
- `ddv.config.yaml` に `tokens` があれば `ddv -- tokens generate` で生成した `<mocksRoot>/_tokens/<name>.css` もモックで `<link>` し、実アプリの色・余白に合わせる
- 受入で確かめたい画面・データの記録は、ステップの `evidence:`（`use: screenshot` / `db` / `command` / hooks の名前、`at: before|after`、`with:`）で指定する。DB の SQL は読み取りだけ。使える名前は `ddv -- evidence list`、`ddv-lint` が名前・引数を検査する
- ddv のモック表示のプレイヤーで全シナリオを再生し、すべて「完了」になることを確認してからレビュー依頼する
- テンプレート：`../../templates/docs/mocks/sample/`
## 手順

1. テンプレート `../../templates/docs/design/basic/sample.md` を元に書く（`SAMPLE` を置換）
2. テストIDを採番する（既存IDは変わらない。消えた経路は欠番、新経路は末尾に追加）し、続けてシナリオの骨組みを生成する（`ddv -- mock scaffold`）
   ```sh
   npm --prefix "$DDV_HOME" run ddv-testid -- generate --repo <repo>
   ```
3. 品質ゲート
   ```sh
   npm --prefix "$DDV_HOME" run ddv-lint -- --repo <repo>
   ```
   error 0、`traces` 未トレースの warning、モックの画面・操作要素の欠け、シナリオのない経路、要確認の値の warning も解消する
4. `status: review` にして、人間に ddv（`npm --prefix "$DDV_HOME" run ddv -- serve --repo <repo>`）での確認を依頼する。
   伝える内容：追加/変更した図、生成されたテストID数（P/T/S/X 別）、判断に迷った点
5. 修正依頼に対応し、承認されたら `status: approved`。**承認 = テストケース（マトリクス）の承認** とみなす

## Actions での実行の導入（対象リポジトリにワークフローが無いとき）

ビューアから対象リポジトリの Actions でテストを実行できるようにする。人間の承認なしにコミット・マージはしない。

1. `npm --prefix "$DDV_HOME" run ddv -- actions init --repo <repo>` で `.github/workflows/ddv-tests.yml` を配置する
   - 「既存のファイルと内容が異なります」で止まったら差分を人間に見せ、上書きするか確認してから `--force`
2. `ddv.config.yaml` の `runners` に npm 以外のランナー（dotnet 等）があれば、ワークフローの「対象の依存を導入」の後に setup の step を足す
3. 人間に、コミット → 既定ブランチへのマージ → ビューアのテストタブの「Actions」から実行、の順で依頼する（手順の詳細は plugin の README）

## 禁止

- 承認済みの要件定義を書き換えない（変更が必要なら人間に提案して要件定義に戻る）
- `.ddv/testids.lock.json` を手で編集しない
