---
id: MOCKRT
kind: detailed
status: approved
title: モック runtime・プレイヤー連携 詳細設計
traces: [BD-MOCK]
---

# モック runtime・プレイヤー連携 詳細設計

## 前提

- 属性・疑似 API の規約は :ref[../basic/mock-player.md#モック-html-の属性] と :ref[../basic/mock-player.md#疑似apiapiyaml]、プレイヤーの状態は :ref[../basic/mock-player.md#プレイヤー] を参照
- runtime は新パッケージ `packages/mock-runtime`。Vite のライブラリモードで依存込みの単一 ES モジュール `dist/mock-runtime.js` にし、`ddv mock init` が `<mocksRoot>/_ddv/` へコピーする。先頭に版を書き、lint で ddv の版と比べる
- ステップ解釈は `@ddv/mock/step` の `executeStep` を同梱して使う（:ref[scenario.md#ステップ解釈]）

## 構造

```mermaid id=class
classDiagram
  class MockRuntime {
    +version: string
    +start(doc) Promise~void~
    +reset(fixtures) Promise~void~
    +step(step) Promise~StepResult~
    +on(name, handler)
    +route(spec, handler)
  }
  class MemoryDb {
    -tables: Map~string, Table~
    +reset(defs, rows)
    +list(table, filter) Row[]
    +get(table, key) Row
    +insert(table, row) Row
    +update(table, key, patch) Row
    +remove(table, key)
  }
  class Table {
    +name: string
    +key: string
    +rows: Row[]
    +nextId: number
  }
  class ApiRouter {
    -routes: Route[]
    -handlers: Map~string, Handler~
    +handle(req) Promise~MockResponse~
  }
  class FetchInterceptor {
    -original: fetch
    +install(router, base)
    +uninstall()
  }
  class ScreenController {
    +current: string
    +show(id)
  }
  class DeclarativeBinder {
    +bind(root)
    +onShow(screen)
  }
  class Validator {
    +validate(scope) ValidationResult
  }
  class HostBridge {
    +listen(runtime)
    +notify(message)
  }
  class DomDriver
  class Driver {
    <<interface>>
  }
  MockRuntime *-- MemoryDb
  MockRuntime *-- ApiRouter
  MockRuntime *-- FetchInterceptor
  MockRuntime *-- ScreenController
  MockRuntime *-- DeclarativeBinder
  MockRuntime *-- HostBridge
  MemoryDb "1" *-- "*" Table
  ApiRouter --> MemoryDb
  DeclarativeBinder --> Validator
  DeclarativeBinder --> ScreenController
  Driver <|.. DomDriver
  DomDriver --> ScreenController
```

- ページから使う口は `window.__ddv`（`MockRuntime` のインスタンス）。`mock.js` は `import { mock } from '../_ddv/mock-runtime.js'` で `on` / `route` を使う
- `api.yaml` の `tables` は文字列（キー `id`）または `{ name, key }`。`insert` でキーが無ければ `nextId` を採番する

## 起動とリセット

```mermaid id=boot-seq
sequenceDiagram
  participant H as モック HTML
  participant R as MockRuntime
  participant F as FetchInterceptor
  participant D as MemoryDb
  participant S as ScreenController
  participant B as HostBridge
  H->>R: import（DOMContentLoaded 後に start）
  R->>R: api.yaml と fixtures/*.yaml を元の fetch で読む
  R->>F: install(router, base)
  R->>D: reset(tables, fixtures/default.yaml)
  R->>S: show(最初の data-screen)
  R->>B: listen
  B-->>H: parent へ ddv:ready { screen, version }
  Note over B: ビューア外（別タブ）では parent が自分なので送らない
  B->>R: ddv:reset { fixtures }
  R->>D: reset(tables, 指定 fixtures を順に重ねる)
  R->>S: show(start)
  B-->>H: ddv:ready { screen }
```

## プロトコル（postMessage）

| 方向 | type | 内容 |
|---|---|---|
| ビューア → iframe | `ddv:reset` | `{ fixtures: string[], start?: string }` |
| ビューア → iframe | `ddv:step` | `{ index, step, highlight?: { holdMs } }`（`highlight` ありなら操作要素を枠で示す） |
| iframe → ビューア | `ddv:ready` | `{ screen, version }` |
| iframe → ビューア | `ddv:result` | `{ index, ok, screen, failures: { key, expected, actual }[] }` |
| iframe → ビューア | `ddv:screen` | `{ screen }`（人が直接操作して画面が変わったとき） |
| iframe → ビューア | `ddv:error` | `{ message }`（api.yaml の形式違反など） |

- 受信側は `event.origin === location.origin` と `event.source` を確認し、それ以外は無視する

```mermaid id=bridge code=BRIDGE matrix nswitch=0
stateDiagram-v2
  state "起動中" as Booting
  state "待機" as Ready
  state "実行中" as Running
  state "異常" as Broken
  [*] --> Booting
  Booting --> Ready : 読込完了
  Booting --> Broken : 読込失敗
  Ready --> Running : step
  Running --> Ready : 完了
  Ready --> Booting : reset
  Running --> Booting : reset
  Broken --> Booting : reset
```

- 起動中・異常の `step` は実行せず `ddv:result { ok: false }`（理由付き）を返す。実行中の `step` は待ち行列に入れて順に実行する
- 実行中の `reset` は実行中のステップを破棄する（結果は送らない）

## 疑似 API

```mermaid id=route code=ROUTE matrix nswitch=0
flowchart TD
  A[fetch 呼出] --> B{URL が base 配下}
  B -->|いいえ| PT[元の fetch へ]
  B -->|はい| C{method と path が<br/>ルートに一致}
  C -->|なし| N404[404 を返す]
  C -->|あり| H{JS ハンドラが登録済み}
  H -->|あり| HR[ハンドラの戻り値]
  H -->|なし| W{when のどれかが真}
  W -->|真| WR[その応答を返す]
  W -->|なし| O[op を DB に実行]
  O --> R{op の結果}
  R -->|キーがない| N404
  R -->|成功| OK[status と結果を返す]
```

- `base` は `api.yaml` の `base`（既定 `/api`）。path の `:name` はパラメータ
- `when.if` は安全な式評価器 `evalCondition` で評価する（`eval` は使わない）。使えるのは、参照（`body.x` / `params.x` / `query.x` / `<表>[式].列`）、比較（`== != < <= > >=`）、`&& || !`、数値・文字列・真偽値。評価できない式は `ddv:error` を送り、偽として扱う
- 応答に遅延は付けない（決定的にする）。遅延を確認したいときは `mock.route` で書く

## 宣言属性

`data-submit` のボタンを押したときの振る舞い。`data-goto` は検査なしで `show` する。

```mermaid id=submit code=SUBMIT matrix nswitch=0
stateDiagram-v2
  state "待機" as Idle
  state "検査中" as Validating
  state "送信中" as Sending
  state "エラー表示" as ShowError
  [*] --> Idle
  Idle --> Validating : クリック [data-validate あり]
  Idle --> Sending : クリック [data-validate なし]
  Validating --> ShowError : 検査 [NG]
  Validating --> Sending : 検査 [OK]
  Sending --> Idle : 応答 [2xx]
  Sending --> ShowError : 応答 [2xx 以外]
  ShowError --> Validating : クリック [data-validate あり]
  ShowError --> Sending : クリック [data-validate なし]
```

- 応答 2xx は `data-ok` の画面へ、それ以外は `data-ng` があればその画面へ、なければ画面に留まり `data-error` の要素に応答の `message` を表示する
- 送信中の再クリックは無視する。送信内容は画面内の `data-testid` 付き入力要素を `{ キー: 値 }` にしたもの
- `data-bind` は `show` のたびに GET し直す（DB の変化を反映）。`template` 内の `{{列}}` はテキストとして置換する（HTML は解釈しない）

## プレイヤー（ビューア側）

`PlayerController`（`apps/web/src/player.ts`）が状態を持ち、`MockFrame` が表示する。状態と遷移は :ref[../basic/mock-player.md#プレイヤー] の図のとおり。

```mermaid id=rewind-seq
sequenceDiagram
  actor U as レビュアー
  participant P as PlayerController
  participant F as iframe（HostBridge）
  U->>P: ステップ k を選ぶ（巻き戻し）
  P->>F: ddv:reset { fixtures, start }
  F-->>P: ddv:ready
  loop i = 0 .. k-1（待機なし）
    P->>F: ddv:step { i }
    F-->>P: ddv:result
  end
  P->>P: cursor = k、状態 = 一時停止
```

- 速度は 1 ステップごとの待機 = 1000ms ÷ 倍率（0.25× = 4000、0.5× = 2000、0.75× = 1333、1× = 1000、1.5× = 667、2× = 500、4× = 250、最速 = 0）
- 応答待ちの上限は 10 秒（ハイライト時は＋保持時間 ×（入力キー数＋クリック 1））。超えたら失敗（理由「モックが応答しません」）にする
- ハイライト：オンのとき、再生・1 ステップの `ddv:step` に `highlight: { holdMs }` を付ける（holdMs = 400ms ÷ 倍率、最速 = 0）。巻き戻しの即時再実行では付けない
- runtime（`DomDriver`）は `fill` / `click` の前に対象要素へ `data-ddv-highlight` を付けて `holdMs` 待ち、操作後に外す。見た目は runtime が注入するスタイル（`outline: 3px solid #f59e0b`）。`expect` の確認対象は強調しない
- 再生中の遷移の強調は、シナリオ取得時の `transitions[i]` の辺番号を `DiagramBlock` の強調に渡す
