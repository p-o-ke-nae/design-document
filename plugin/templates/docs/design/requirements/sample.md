---
id: SAMPLE
kind: requirements
status: draft
title: SAMPLE 要件定義
---

# SAMPLE 要件定義

<!-- 図で表す。文章は箇条書き・表の最小限にする。SAMPLE は文書ID（英大文字）に置き換える -->

## 目的

- 誰の・何の困りごとを解決するか（1〜2行）
- 成功の判定基準（測れる形）：〇〇を △△ → □□ にする

## 現状 (As-Is)

<!-- 今のやり方。課題のあるノードは class X issue で印を付ける -->

```mermaid id=flow-asis
flowchart LR
  A([利用者]) --> B[手作業で記録]
  B --> C[目視で確認]
  C --> D([完了])
  classDef issue fill:#fde2e2,stroke:#c62828
  class B issue
```

## あるべき姿 (To-Be)

<!-- As-Is と同じノードIDを使う。差分（ギャップ）ごとに %% req: <ノードID または 元->先> <要件ID> を書く -->

```mermaid id=flow-tobe compare=flow-asis
flowchart LR
  %% req: E REQ-001
  %% req: A->E REQ-001
  %% req: E->C REQ-001
  %% req: B REQ-001
  %% req: A->B REQ-001
  %% req: B->C REQ-001
  A([利用者]) --> E[画面で入力]
  E --> C[目視で確認]
  C --> D([完了])
```

## スコープ

<!-- システム境界を subgraph で表す。範囲外も明示する -->

```mermaid id=context
flowchart LR
  User([利用者]) --> UI
  subgraph System[SAMPLE（範囲内）]
    UI[画面] --> API[API] --> DB[(DB)]
  end
  API -.-> Ext[[外部システム（範囲外）]]
```

## ユースケース

```mermaid id=usecase
flowchart LR
  User([利用者]) --- UC1((〇〇する))
```

## 要件一覧

| ID | 種別 | 要件 | 優先度 |
|---|---|---|---|
| REQ-001 | 機能 | 利用者が画面で〇〇を入力できる | 高 |

## 受入基準

| 要件 | 受入基準 |
|---|---|
| REQ-001 | 〇〇を入力して確定すると △△ になる |
