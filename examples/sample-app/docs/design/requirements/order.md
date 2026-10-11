---
id: ORDER
kind: requirements
status: approved
title: 注文受付システム 要件定義
---

# 注文受付システム 要件定義

## 目的

- 電話と紙で受けている注文を Web 化し、受付から出荷指示までを当日中に終える
- 成功の判定基準：受付から出荷指示までの平均時間 2 日 → 4 時間以内、転記ミス 0 件

## 現状 (As-Is)

```mermaid id=flow-asis
flowchart LR
  A([顧客]) -->|電話| B[担当者が紙に記入]
  B --> C[在庫を目視確認]
  C --> D[Excelに転記]
  D --> E[上長が紙で承認]
  E --> F([出荷])
  classDef issue fill:#fde2e2,stroke:#c62828
  class B,D issue
```

## あるべき姿 (To-Be)

```mermaid id=flow-tobe compare=flow-asis
flowchart LR
  %% req: G REQ-001
  %% req: A->G REQ-001
  %% req: G->C REQ-002
  %% req: C REQ-002
  %% req: E REQ-003
  %% req: B REQ-001
  %% req: D REQ-001
  %% req: A->B REQ-001
  %% req: B->C REQ-001
  %% req: C->D REQ-002
  %% req: C->E REQ-002
  %% req: D->E REQ-002
  A([顧客]) -->|Web| G[注文入力画面]
  G --> C[在庫を自動引当]
  C --> E[上長がWebで承認]
  E --> F([出荷])
```

## スコープ

```mermaid id=context
flowchart LR
  Customer([顧客]) --> Web
  Manager([上長]) --> Web
  subgraph System[注文受付システム（範囲内）]
    Web[Web画面] --> API[注文API] --> DB[(注文DB)]
  end
  API --> Stock[[在庫システム（範囲外・既存）]]
  API -.-> Ship[[出荷システム（範囲外）]]
```

## ユースケース

```mermaid id=usecase
flowchart LR
  Customer([顧客]) --- UC1((注文する))
  Customer --- UC2((注文を取り消す))
  Manager([上長]) --- UC3((注文を承認/却下する))
```

## 要件一覧

| ID | 種別 | 要件 | 優先度 |
|---|---|---|---|
| REQ-001 | 機能 | 顧客が Web で注文を入力・確定できる | 高 |
| REQ-002 | 機能 | 注文確定時に在庫を自動で引き当てる | 高 |
| REQ-003 | 機能 | 上長が Web で注文を承認/却下できる | 高 |
| REQ-004 | 非機能 | 画面操作の応答は 1 秒以内 | 中 |

## 受入基準

| 要件 | 受入基準 |
|---|---|
| REQ-001 | 注文入力 → 確認 → 確定で注文が「申請中」になる |
| REQ-002 | 在庫不足の商品は確定できない |
| REQ-003 | 承認で「承認済」、却下で「却下」になり、却下は修正して再申請できる |
| REQ-004 | 一覧・入力・確認画面の操作が 1 秒以内に応答する |
