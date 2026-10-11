---
id: SCENARIO
kind: detailed
status: review
title: シナリオ・骨組み生成・E2E 実行 詳細設計
traces: [BD-MOCK]
---

# シナリオ・骨組み生成・E2E 実行 詳細設計

## 前提

- 成果物・ファイル規約は :ref[../basic/mock-player.md#成果物]、シナリオ形式は :ref[../basic/mock-player.md#シナリオ] を参照
- 実装は新パッケージ `packages/mock`（`@ddv/mock`）。エントリは `.`（Node 用：形式・検証・照合・骨組み生成）、`./step`（ブラウザと共用のステップ解釈）、`./playwright`（E2E 実行器）
- 追加依存：`node-html-parser`（モック HTML の静的解析）。YAML は既存の `yaml`、形式は `zod`

## 構造

```mermaid id=class
classDiagram
  class Scenario {
    +id: string
    +title: string
    +fixtures: string[]
    +start: string
    +steps: Step[]
  }
  class Step {
    +event: string
    +input?: Record~string, Value~
    +click?: string
    +do?: string
    +wait?: number
    +expect: Expect
  }
  class Expect {
    +screen: string
    +visible?: string[]
    +hidden?: string[]
    +text?: Record~string, string~
    +count?: Record~string, number~
  }
  class ScenarioFile {
    +path: string
    +scenario?: Scenario
    +todos: TodoMark[]
    +issues: ScenarioIssue[]
  }
  class PathSpec {
    +id: string
    +title: string
    +start: string
    +transitions: PathTransition[]
  }
  class PathTransition {
    +from: string
    +to: string
    +event: string
    +guard: string
  }
  class MockModel {
    +screens: Map~string, ScreenModel~
  }
  class ScreenModel {
    +id: string
    +events: Map~string, string~
    +fields: FieldModel[]
    +submitters: Set~string~
  }
  class FieldModel {
    +key: string
    +kind: FieldKind
    +required: boolean
    +min?: number
    +max?: number
    +maxLength?: number
    +pattern?: string
    +options: string[]
    +sample?: string
  }
  class FieldKind {
    <<enumeration>>
    text
    number
    select
    checkbox
  }
  class Driver {
    <<interface>>
    +fieldKind(key) FieldKind
    +fill(key, value)
    +click(key, event)
    +invoke(name)
    +screen() string
    +isVisible(key) boolean
    +text(key) string
    +count(key) number
  }
  class PlaywrightDriver
  class ScreenMap {
    +screens: Record~string, ScreenRule~
    +events: Record~string, string~
    +fields: Record~string, string~
  }
  Scenario "1" *-- "*" Step
  Step *-- Expect
  ScenarioFile o-- Scenario
  PathSpec "1" *-- "*" PathTransition
  MockModel "1" *-- "*" ScreenModel
  ScreenModel "1" *-- "*" FieldModel
  FieldModel --> FieldKind
  Driver <|.. PlaywrightDriver
  PlaywrightDriver ..> ScreenMap : 実アプリ
```

| 関数 | モジュール | 役割 |
|---|---|---|
| `parseScenarioFile(text, path)` | `scenario.ts` | YAML → `ScenarioFile`。`# 要確認` コメントの行を `todos` に集める |
| `pathSpecs(doc, diagram, lock)` | `paths.ts` | ロックの active な P ケースを `PathSpec[]` に変換（ガードは `splitLabel` で分離） |
| `matchPath(scenario, path)` | `match.ts` | シナリオと経路の照合（[経路照合](#経路照合)） |
| `analyzeMockHtml(html)` | `analyze.ts` | `data-screen` / `data-event` / 入力要素と制約 → `MockModel` |
| `scaffoldScenario(path, mock)` | `scaffold.ts` | 経路 1 本の骨組みと要確認の一覧を作る |
| `inferValue(field, mode)` | `infer.ts` | 候補値（[候補値](#候補値)） |
| `mergeScenario(existing, generated)` | `merge.ts` | 再生成時のマージ（[マージ](#マージ)） |
| `scaffoldMock(repo, config, mock?)` | `scaffold-cli.ts` | 1 モック分を生成し、ファイル書込・`_retired/` 移動・件数を返す |
| `checkMocks(repo, config, docs, lock)` | `check.ts` | lint 拡張（:ref[../basic/mock-player.md#検査ddv-lint-拡張]）。`lintDocs` から呼ぶ |
| `executeStep(driver, step)` | `step.ts` | ステップ解釈（プレイヤーと E2E で共用） |
| `defineScenarioTests(opts)` / `runScenario(page, scenario, target)` | `playwright.ts` | E2E 実行器 |

- `Value` は `string | number | boolean`。式は受け付けない（REQ-109）。形式違反は `ScenarioIssue`（行番号付き）にする

## 骨組み生成の流れ

```mermaid id=scaffold-seq
sequenceDiagram
  participant C as scaffoldMock
  participant D as docs / lock
  participant A as analyzeMockHtml
  participant S as scaffoldScenario
  participant M as mergeScenario
  participant F as scenarios/
  C->>D: ::mock[name/index.html] を持つ文書（基本設計を優先）と、diagram= で指定した図（無ければ最初の matrix 状態図）
  D-->>C: pathSpecs（active な P）
  C->>A: index.html
  A-->>C: MockModel
  loop PathSpec ごと
    C->>S: path, model
    S-->>C: Scenario（生成）, todos
    C->>F: <ID>.yaml を読む（あれば）
    C->>M: existing, generated
    M-->>C: Scenario（マージ後）
    C->>F: 変更があれば書込（todos は # 要確認 コメント）
  end
  C->>F: active でない ID のファイルを _retired/ へ移動
```

- 書込は `yaml` の `Document` で行い、人間が付けたコメントを保持する。キー順は `id, title, fixtures, start, steps`
- `fixtures` の既定は `[default]`（`fixtures/default.yaml` があるとき）、なければ `[]`

## 経路照合

`matchPath` はステップと遷移を先頭から 1 対 1 に照合し、最初の不一致を返す。

```mermaid id=match code=MATCH matrix nswitch=0
flowchart TD
  A[照合開始] --> B{start が経路の最初の状態と一致}
  B -->|不一致| E1[不一致: start]
  B -->|一致| C{ステップ数が遷移数と一致}
  C -->|不一致| E2[不一致: ステップ数]
  C -->|一致| D{各ステップの event がイベントとガードに一致}
  D -->|不一致| E3[不一致: event とステップ番号]
  D -->|一致| F{各ステップの expect.screen が遷移先と一致}
  F -->|不一致| E4[不一致: 画面とステップ番号]
  F -->|一致| OK[一致]
```

- `event` の比較は空白を正規化し、`イベント [ガード]` の形で行う（ガードなしは `イベント` のみ）

## 候補値

`inferValue(field, mode)`。`mode` は `ok`（遷移先が別画面）か `ng`（遷移先が遷移元と同じ画面）。

```mermaid id=infer code=INFER matrix nswitch=0
flowchart TD
  A[項目] --> M{mode が ng で<br/>最初の required 項目}
  M -->|はい| NG[空文字]
  M -->|いいえ| S{data-sample がある}
  S -->|あり| V1[data-sample の値]
  S -->|なし| K{kind}
  K -->|number| N[min があれば min、なければ 1]
  K -->|select| L[空でない最初の選択肢]
  K -->|checkbox| CB[required なら true、それ以外 false]
  K -->|text| P{pattern がある}
  P -->|あり| T[要確認: 空文字]
  P -->|なし| X[テスト を maxLength で切り詰め]
```

- `ng` のとき required 項目がなければ、そのステップの `input` を空にして要確認にする
- select に有効な選択肢がない場合も要確認にする

## マージ

生成したステップごとに、既存ステップを `event` と `expect.screen` の組で探す（同じ組が複数あれば出現順で対応）。

```mermaid id=merge code=MERGE matrix nswitch=0
flowchart TD
  A[生成したステップ] --> B{既存に同じ event と遷移先がある}
  B -->|なし| N[生成値をそのまま採用]
  B -->|あり| C{既存に input がある}
  C -->|あり| K1[input は既存を採用]
  C -->|なし| K2[input は生成値を採用]
  K1 --> D{既存の expect に screen 以外がある}
  K2 --> D
  D -->|あり| E1[追加の期待値を保持]
  D -->|なし| E2[expect は生成値]
```

- 生成項目（`title`・`start`・`event`・`click`・`expect.screen`）は常に生成値。`fixtures`・`wait`・`do` は既存を保持
- 対応しなかった既存ステップは削除し、件数を「更新」に含めて報告する
- 結果が既存と同じなら書き込まない（更新日時を変えない。シナリオの状態判定のため）

## ステップ解釈

`executeStep(driver, step)` は `Driver` だけに依存し、プレイヤー（`DomDriver`）と E2E（`PlaywrightDriver`）が同じ実装を使う。

```mermaid id=step code=STEP matrix nswitch=0
flowchart TD
  A[ステップ開始] --> F{input の要素がすべてある}
  F -->|ない| E0[失敗: 要素が見つからない]
  F -->|ある| F2[項目ごとに fieldKind に応じて fill]
  F2 --> D{do の名前が登録済み}
  D -->|未登録| E1[失敗: 未登録の操作]
  D -->|登録済み / do なし| C{click の要素がある}
  C -->|ない| E0
  C -->|ある / click なし| CK[click と wait を実行]
  CK --> X{expect を満たす<br/>タイムアウトまで再試行}
  X -->|満たさない| E2[失敗: 期待値と実際の値]
  X -->|満たす| OK[成功]
```

- 実行順は input → do → click → wait → expect で固定。キーがないものは飛ばす
- `fill` は `fieldKind` が text/number なら入力、select なら選択、checkbox なら `true`/`false` に合わせる
- 要素が見つからないときは `StepError`（`kind: notFound`、キー名）で失敗する
- `expect` の再試行は既定 5 秒（`defineScenarioTests({ timeout })` で変更可）。プレイヤーは画面描画後に 1 回だけ判定する

## E2E 実行

```mermaid id=e2e-seq
sequenceDiagram
  participant P as Playwright
  participant D as defineScenarioTests
  participant R as runScenario
  participant T as resolveTarget
  participant V as PlaywrightDriver
  P->>D: spec 読込
  D->>D: <mocksRoot>/**/scenarios/*.yaml を読み、検証エラーのものは test.fail として登録
  D->>P: test("[ID] title") × シナリオ数
  P->>R: page, scenario
  R->>T: DDV_BASE_URL, モック名
  T-->>R: Target（mock: 静的配信 URL / app: baseURL ＋ _map.yaml）
  alt mock
    R->>V: goto(モック URL) → window.__ddv.reset(fixtures)
  else app
    R->>V: goto(baseURL) → seed(fixtures)（未登録なら投入しない）
  end
  loop ステップごと
    R->>V: executeStep
  end
```

- モックの静的配信は、`globalSetup` で `mocksRoot` を一時ポートで配信する（`DDV_BASE_URL` 未設定時のみ）
- `seed` と `do` の実装は利用側の `e2e/ddv-hooks.ts`（任意）から `export const seed / steps` として読み込む（AI が書く）
- テスト紐づけ：`RunnerSchema` に `scenarios: boolean`（既定 false）を追加。true の playwright ランナーは `scanTestLinks` で `<mocksRoot>/**/scenarios/*.yaml` の `id:` 行も紐づける（`test` はシナリオの `title`）

## 要素の解決

`PlaywrightDriver` がキー（イベント名・画面ID・項目キー）からロケーターを決める。

```mermaid id=resolve code=RESOLVE matrix nswitch=0
flowchart TD
  A[キー] --> T{対象}
  T -->|mock| K{種類}
  K -->|画面| M1["[data-screen=ID] が表示中"]
  K -->|イベント| M2["表示中の画面内の [data-testid=click の値]"]
  K -->|項目| M3["[data-testid=キー]"]
  T -->|app| K2{種類}
  K2 -->|画面| S{_map.yaml の screens にある}
  S -->|なし| E1[失敗: 対応表に画面がない]
  S -->|あり| S2[url パターンまたはセレクタで判定]
  K2 -->|イベント| V{_map.yaml の events にある}
  V -->|なし| E2[失敗: 対応表にイベントがない]
  V -->|あり| V2[対応表のセレクタ]
  K2 -->|項目| F{_map.yaml の fields にある}
  F -->|あり| F2[対応表のセレクタ]
  F -->|なし| F3["[data-testid=キー]"]
```

`_map.yaml` の形式（`ScreenMapSchema`）：

```yaml
screens:
  List: { url: "/orders$" }              # url は正規表現（パス部分に一致）
  Input: { selector: "h1:has-text('注文入力')" }
events:
  新規: "a[href='/orders/new']"
  次へ: "button[type=submit]"
fields:
  customer: "#customerName"
```

- モックの click の値は、骨組み生成で data-event の要素の data-testid を入れる（data-testid がなければ要確認）。実アプリは click の値を使わず、ステップの `event`（ガードを除く）で対応表を引く
- 対応表の検証（存在しない状態ID・イベント名）は lint の warning にする
