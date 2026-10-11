---
id: VIEWER
kind: basic
status: review
title: ddv ビューア 基本設計
traces: [REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007]
---

# ddv ビューア 基本設計

## 前提

目的は :ref[../requirements/ddv.md#目的] を参照。

## 画面遷移

```mermaid id=screen-flow code=SCREEN matrix nswitch=0
stateDiagram-v2
  [*] --> ドキュメント
  ドキュメント --> テスト : テストタブ
  テスト --> ドキュメント : ドキュメントタブ
  ドキュメント --> 参照ポップアップ : 参照クリック
  参照ポップアップ --> ドキュメント : Esc
```

## テスト実行

```mermaid id=run-state code=RUN matrix nswitch=0
stateDiagram-v2
  [*] --> 待機
  待機 --> 実行中 : 実行
  実行中 --> 成功 : 終了 [全件成功]
  実行中 --> 失敗 : 終了 [失敗あり]
  成功 --> 実行中 : 実行
  失敗 --> 実行中 : 実行
```

- 実行中の「実行」は受け付けない（サーバは 409、画面はボタン非活性）

```mermaid id=run-seq
sequenceDiagram
  actor U as 開発者
  participant W as ビューア
  participant S as サーバ
  participant R as テストランナー
  U->>W: 実行（テストID指定 or 全件）
  W->>S: POST /api/tests/run
  S-->>W: 202 { id }
  W->>S: GET /api/runs/{id}/events (SSE)
  S->>R: vitest -t / playwright --grep / dotnet test --filter
  R-->>S: 標準出力
  S-->>W: event: log
  R-->>S: JUnit XML / TRX
  S->>S: テストIDに対応付けて .ddv/runs に保存
  S-->>W: event: end
  W->>S: GET /api/results/latest
  W-->>U: 結果バッジ更新
```

## エラー表示（共通）

ビューアのどの画面にも共通する、想定外の応答・エラーの扱い。各画面に固有のエラー表示（入力チェック、取得失敗の理由など）は各設計書に従い、ここではその前提をそろえる。

- サーバの応答が JSON でない、または期待する形（一覧なのに一覧でない等）でないときは**通信の失敗として扱う**。成功として画面に渡さない。各画面は既存の取得失敗の表示に「サーバの応答を解釈できません（サーバが古い可能性があります。再起動してください）」を出す
  - 例：ビューアだけ新しく、起動中のサーバが古いと、未知の API に画面の HTML が返ることがある
- 描画中の想定外のエラーで**画面全体を消さない**（白い画面にしない）。ヘッダ（ワークスペース切替・タブ）は残し、本文の領域にエラー内容と「再読み込み」ボタンを表示する。ワークスペースや文書を切り替えると表示し直す
- サーバは、存在しない `/api/*` に JSON の 404（`{ error }`）を返す。画面の HTML（SPA のフォールバック）は返さない

## 構成

```mermaid id=components
flowchart LR
  subgraph Web[apps/web]
    Doc[DocPage] --> MV[MermaidView]
    Doc --> MP[MatrixPanel]
    Doc --> Ref[Ref/Embed]
    Tests[TestsPage]
  end
  subgraph Server[apps/server]
    API[Hono API] --> Runs[RunManager]
    Runs --> Runner[executeRunner]
  end
  subgraph Pkgs[packages]
    Core[core: md/lint]
    Graph[graph: 図解析/経路/差分]
    TID[testid: 採番/ロック/走査]
  end
  Web -->|REST + SSE| API
  API --> Core
  API --> TID
  TID --> Graph
  Core --> Graph
```

## データ

```mermaid id=er
erDiagram
  DOCUMENT ||--o{ DIAGRAM : contains
  DIAGRAM ||--o{ TEST_CASE : "matrix で生成"
  TEST_CASE ||--o{ TEST_LINK : "IDで紐づく"
  RUN ||--o{ RESULT : has
  TEST_CASE ||--o{ RESULT : "最新結果"
  TEST_CASE {
    string id PK "BD-VIEWER-RUN-T001"
    string signature "経路の正規化表現"
    string status "active / retired"
  }
  TEST_LINK {
    string id FK
    string runner
    string file
    string test
  }
  RUN {
    string id PK
    string status
    datetime startedAt
  }
```

- TEST_CASE は `.ddv/testids.lock.json`、RUN/RESULT は `.ddv/runs/*.json` に保存する
