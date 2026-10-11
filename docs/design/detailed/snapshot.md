---
id: SNAPSHOT
kind: detailed
status: approved
title: スナップショット 詳細設計
traces: [BD-MOCK]
---

# スナップショット 詳細設計

## 前提

- 状態と流れは :ref[../basic/mock-player.md#スナップショット]、設定は :ref[../basic/mock-player.md#設定と-cli] を参照
- 実装は `apps/server/src/snapshots.ts`（サービス）と `packages/mock/src/image.ts`（比較）。追加依存は `pixelmatch` と `pngjs`

## 構造

```mermaid id=class
classDiagram
  class SnapshotService {
    +run(ids) RunRecord
    +list(id) StepSnapshot[]
    +approve(id, steps)
  }
  class SnapshotStore {
    +root: string
    +baseline(id, step) Path
    +current(id, step) Path
    +diff(id, step) Path
    +readMeta(kind, id) SnapshotMeta
    +writeMeta(kind, id, meta)
  }
  class SnapshotMeta {
    +browser: string
    +viewport: Viewport
    +takenAt: string
    +steps: number
  }
  class StepSnapshot {
    +scenario: string
    +step: number
    +status: SnapStatus
    +diffRatio?: number
    +warnings: string[]
  }
  class SnapStatus {
    <<enumeration>>
    None
    NoBase
    Match
    Diff
  }
  class BrowserLauncher {
    +channel() string
    +launch() Browser
  }
  SnapshotService --> SnapshotStore
  SnapshotService --> BrowserLauncher
  SnapshotService ..> StepSnapshot
  SnapshotStore ..> SnapshotMeta
  StepSnapshot --> SnapStatus
```

- 置き場所：`.ddv/snapshots/{baseline,current,diff}/<テストID>/<ステップ番号 3 桁>.png` と `meta.json`
- 実行の進捗は既存の `RunManager` の仕組み（SSE `/api/runs/{id}/events`）に `kind: snapshot` の実行として載せる
- `ConfigSchema` に `mock`（`browser.channel` 既定 `chromium`、`snapshot.threshold` 既定 0.001、`snapshot.viewport` 既定 1280×800）を追加する

## 撮影

```mermaid id=run-seq
sequenceDiagram
  participant S as SnapshotService
  participant L as BrowserLauncher
  participant R as runScenario
  participant C as compareImages
  participant T as SnapshotStore
  S->>L: launch()
  L-->>S: Browser（channel）
  loop シナリオごと
    S->>T: current/<ID>/ を空にする
    S->>R: page, scenario, { onStep }
    loop ステップごと（expect 成功後）
      R-->>S: onStep(i)
      S->>T: page.screenshot → current
      S->>C: baseline, current, threshold
      C-->>S: ratio, diffPng
      S->>T: diff を保存
    end
    S->>T: writeMeta(current, ID)
  end
```

- 撮影はモック対象だけ（`DDV_BASE_URL` は無視する）。アニメーションは `animations: 'disabled'`、キャレットは非表示
- ステップの失敗で、そのシナリオの撮影を打ち切る（以降のステップは None のまま）

## ブラウザの選択

```mermaid id=channel code=CHANNEL matrix nswitch=0
flowchart TD
  A[launch] --> E{環境変数<br/>DDV_BROWSER_CHANNEL がある}
  E -->|あり| V1[環境変数の値]
  E -->|なし| V2[設定 mock.browser.channel]
  V1 --> C{値が chromium}
  V2 --> C
  C -->|はい| B1[channel を指定せず同梱 Chromium]
  C -->|いいえ| B2[channel を指定して起動]
  B2 --> I{起動できた}
  I -->|失敗| ERR[エラー: ブラウザが見つからない]
  I -->|成功| OK[起動]
  B1 --> OK
```

- 起動エラーには `npx playwright install` または該当ブラウザのインストールを促す文言を付ける

## 比較

`compareImages(baseline, current, threshold)` とステップの状態判定。

```mermaid id=compare code=CMP matrix nswitch=0
flowchart TD
  A[ステップの画像] --> B{基準画像がある}
  B -->|なし| NB[NoBase]
  B -->|あり| S{画像サイズが同じ}
  S -->|違う| DF1[Diff: ratio 1]
  S -->|同じ| P[pixelmatch で差分画素数]
  P --> R{差分画素 / 全画素 が閾値以下}
  R -->|以下| M[Match]
  R -->|超える| DF2[Diff]
```

- pixelmatch の色の許容値は 0.1（既定）。差分画像は常に保存する
- 基準と今回の `meta.browser` / `viewport` が違うときは状態に関係なく warning（`撮影環境が基準と異なります`）を付ける

## 承認

- `approve(id, steps?)`：指定ステップ（省略時は全ステップ）の current を baseline へコピーし、baseline の `meta.json` を current のもので更新する
- 今回の撮影でステップ数が減ったときは、全ステップ承認で baseline の余分なファイルを削除する
- None のステップは承認できない（400）
