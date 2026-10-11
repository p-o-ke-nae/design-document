---
name: ddv-requirements
description: ddv（Design Doc Viewer）形式の要件定義を作る。plan モードで目的→As-Is→課題→To-Be→スコープ→受入基準の順にヒアリングし、Mermaid 図中心の requirements ドキュメントを出力して ddv lint を通す。要件定義・要求整理・新機能の相談の開始時に使う。
---

# ddv 要件定義

人間との対話（plan モード推奨）で要件を固め、`docs/design/requirements/<name>.md` を作る。
成果物は **図が主、文章は箇条書き・表の最小限**。後工程（基本設計・テスト）のトレース起点になる。

## 進め方（順番を守る）

各ステップで人間の回答を得てから次に進む。**目的が確定するまでスコープや解決策の話をしない。**
不明点は推測で埋めず質問する（質問ツールがあれば選択肢付きで聞く）。

1. **目的**：誰の・何の困りごとか、なぜ今か、成功の判定基準（測れる数値・状態）。判定基準が測れない形なら言い換えを提案して確認する
2. **現状 (As-Is)**：今のやり方を flowchart か stateDiagram で描き、人間に確認する
3. **課題**：As-Is の図の中で課題のあるノードを特定し `classDef issue` で印を付ける
4. **あるべき姿 (To-Be)**：同じ種類の図で描く。**As-Is と同じノードIDを使う**（ビューアが差分＝ギャップを自動計算する）。
   フェンスに `compare=flow-asis` を付け、各ギャップに `%% req: <ノードID|元->先> REQ-NNN` を書く
5. **スコープ**：コンテキスト図（flowchart の subgraph がシステム境界）。範囲外の外部システム/作業も明示
6. **ユースケース**：アクター × ユースケースの flowchart
7. **要件一覧**：`| REQ-NNN | 種別(機能/非機能/制約) | 要件 | 優先度 |` の表
8. **受入基準**：`| REQ-NNN | 受入基準 |`。人間が実際に確認できる操作と結果で書く

## 出力

- テンプレート：このスキルの `../../templates/docs/design/requirements/sample.md`（`SAMPLE` を文書ID＝英大文字に置換）
- 対象リポジトリに `ddv.config.yaml` が無ければ `../../templates/ddv.config.yaml` をルートに置く
- front matter：`id`（英大文字）、`kind: requirements`、`status: draft`、`title`
- Mermaid フェンスには必ず `id=<図ID>` を付ける

## 品質ゲート（レビュー依頼の前に必須）

`DDV_HOME` は ddv リポジトリのクローン先。`<repo>` は対象リポジトリの絶対パス。

```sh
npm --prefix "$DDV_HOME" run ddv-lint -- --repo <repo>
```

- error が 0 になるまで直す（目的/As-Is/To-Be/スコープ/受入基準の欠落、REQ-ID なし、参照切れ、図ID重複）
- warning の「ギャップに要件IDが対応付けられていません」も原則解消する

## 完了条件

- lint の error 0、ギャップすべてに REQ-ID
- 人間に `npm --prefix "$DDV_HOME" run ddv -- serve --repo <repo>`（http://127.0.0.1:5178）での確認を依頼し、
  承認されたら front matter を `status: approved` にする（PR 運用時は PR の Approve を承認とみなす）
- 承認前に基本設計へ進まない
