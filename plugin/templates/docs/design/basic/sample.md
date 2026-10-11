---
id: SAMPLE
kind: basic
status: draft
title: SAMPLE 基本設計
traces: [REQ-001]
---

# SAMPLE 基本設計

## 前提

目的は :ref[../requirements/sample.md#目的] を参照。

::embed[../requirements/sample.md#受入基準]

## 画面遷移

<!-- matrix を付けた状態図/フロー図からテストマトリクスとテストIDが生成される。code はテストIDに入る図の略号 -->

```mermaid id=screen-flow code=SCREEN matrix
stateDiagram-v2
  [*] --> 一覧
  一覧 --> 入力 : 新規
  入力 --> 確認 : 次へ [入力OK]
  入力 --> 入力 : 次へ [入力NG]
  入力 --> 一覧 : キャンセル
  確認 --> 入力 : 戻る
  確認 --> 完了 : 確定
  完了 --> [*]
```

## 画面イメージ

<!-- モックは docs/mocks 配下。実プロジェクトの CSS を link して見た目を合わせる -->

::mock[sample/index.html]

## 処理

```mermaid id=submit-seq
sequenceDiagram
  actor U as 利用者
  participant FE as 画面
  participant BE as API
  participant DB as DB
  U->>FE: 確定
  FE->>BE: POST /items
  BE->>DB: INSERT
  DB-->>BE: id
  BE-->>FE: 201
  FE-->>U: 完了画面
```

## データ

```mermaid id=er
erDiagram
  ITEM {
    int id PK
    string name
    datetime created_at
  }
```
