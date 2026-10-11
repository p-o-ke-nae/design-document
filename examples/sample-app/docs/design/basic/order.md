---
id: ORDER
kind: basic
status: review
title: 注文画面 基本設計
traces: [REQ-001, REQ-002, REQ-003, REQ-004]
---

# 注文画面 基本設計

## 前提

目的は :ref[../requirements/order.md#目的] を参照。

::embed[../requirements/order.md#受入基準]

## 画面遷移

```mermaid id=screen-flow code=SCREEN matrix
stateDiagram-v2
  state "注文一覧" as List
  state "注文入力" as Input
  state "入力確認" as Confirm
  state "完了" as Done
  [*] --> List
  List --> Input : 新規
  Input --> Confirm : 次へ [入力OK]
  Input --> Input : 次へ [入力NG]
  Input --> List : キャンセル
  Confirm --> Input : 戻る
  Confirm --> Done : 確定
  Done --> List : 一覧へ
  Done --> [*]
```

## 画面イメージ

::mock[order/index.html]{scenario=order-happy}

## 注文確定の処理

```mermaid id=submit-seq
sequenceDiagram
  actor U as 顧客
  participant W as Web画面
  participant A as 注文API
  participant S as 在庫システム
  participant D as 注文DB
  U->>W: 確定
  W->>A: POST /orders
  A->>S: 引当(商品, 数量)
  alt 在庫あり
    S-->>A: OK
    A->>D: INSERT orders(status=Submitted)
    A-->>W: 201 Created
  else 在庫不足
    S-->>A: NG
    A-->>W: 409 Conflict
  end
```

## データ

```mermaid id=er
erDiagram
  ORDERS ||--|{ ORDER_ITEMS : has
  ORDERS {
    int id PK
    string customer
    string status
  }
  ORDER_ITEMS {
    int order_id FK
    string sku
    int quantity
  }
```

### 入力チェック

| 項目 | 必須 | 形式 |
|---|---|---|
| 顧客名 | ○ | 1〜50文字 |
| 商品 | ○ | 1件以上 |
| 数量 | ○ | 1〜99 |
