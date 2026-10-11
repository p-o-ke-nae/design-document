---
id: WSPACE
kind: detailed
status: approved
title: ワークスペース・GitHub 接続 詳細設計
traces: [BD-GHREV]
---

# ワークスペース・GitHub 接続 詳細設計

## 前提

- 振る舞いは :ref[../basic/github-review.md#ワークスペース]、認証は :ref[../basic/github-review.md#認証]、置き場所は :ref[../basic/github-review.md#データ] を参照
- 新規パッケージ `packages/github`（認証・REST/GraphQL クライアント。依存追加なし、`fetch` と `child_process`）
- サーバは `apps/server/src/workspaces.ts`（管理）・`git.ts`（git CLI）・`guard.ts`（Host/Origin 検査）を追加し、既存の `createContext` / `createApp` は変えずにワークスペースごとに使う

## 画面

画面遷移は :ref[../basic/github-review.md#画面遷移]。このうち「GitHub を開く」「取得中」を扱う（PR の文書・保留中レビューは :ref[review-comment.md#画面]）。

::mock[github-review/index.html]

| 項目 | testid | 種類 | 型・桁 | 必須 | 初期値 | 取得元・送信先 | 入力チェック・エラー文言 |
|---|---|---|---|---|---|---|---|
| GitHub を開く | `open-github` | ボタン | — | — | — | `OpenDialog` を開く | 認証なし（`GET /api/github/auth` が `none`）：「GitHub にログインしてください（`gh auth login` または `GITHUB_TOKEN`）」を表示して開かない |
| リポジトリ | `repo` | テキスト | 文字列 100 | ○ | 空（最近開いたものを選ぶと補完） | `POST /api/workspaces` の `repo` | 形式違い：「owner/repo の形式で入力してください」（:ref[#ワークスペースid]） |
| 種類 | `kind` | 選択 | `pr` / `ref` | ○ | `pr` | `pr` か `ref` のどちらを送るか | — |
| PR 番号 または branch・tag 名 | `target` | テキスト | 数字（pr）/ 文字列 100（ref） | ○ | 空 | `POST /api/workspaces` の `pr` / `ref` | pr が 1 以上の整数でない：「PR 番号を入力してください」、ref が安全な名前でない：「branch・tag 名を確認してください」 |
| 入力エラー | `open-error` | メッセージ | — | — | 非表示 | `400` の `message` | — |
| 開く | `open-submit` | ボタン | — | — | — | `POST /api/workspaces` → `#/w/<id>/doc` へ。取得中は `LoadingPage` | 同じ ID が開いていればそのワークスペースへ移る |
| キャンセル | `open-cancel` | ボタン | — | — | — | 元の画面に戻る | — |
| オープンな PR | `pulls` | 一覧 | 30 件 | — | — | `GET /api/github/pulls?repo=o/r`（`repo` 入力後に取得。クリックで `target` に番号を入れる） | 取得失敗は一覧を空にして理由を小さく表示 |
| 認証の状態 | `auth-status` | 表示 | — | — | — | `GET /api/github/auth` の `{ source, login }` | トークンは表示しない |
| 進捗 | `progress` | 一覧 | — | — | — | SSE `progress { step }`（PR 情報 → clone → fetch → worktree） | `step: error` は理由を表示し「再試行」「戻る」を出す |
## 構造

```mermaid id=class
classDiagram
  class TokenResolver {
    -cached: ResolvedToken
    +resolve() ResolvedToken
    +invalidate()
    +status() AuthStatus
  }
  class ResolvedToken {
    +source: TokenSource
    +token: string
    +login: string
  }
  class TokenSource {
    <<enumeration>>
    gh
    env
    none
  }
  class GitHubClient {
    +rest(method, path, body) T
    +paginate(path) T[]
    +graphql(query, vars) T
  }
  class GitHubError {
    +kind: GitHubErrorKind
    +status: number
    +message: string
  }
  class GitHubErrorKind {
    <<enumeration>>
    auth
    forbidden
    notFound
    validation
    rateLimit
    network
  }
  class WorkspaceManager {
    +list() WorkspaceInfo[]
    +open(req) Workspace
    +refresh(id)
    +checkHead(id) boolean
    +trust(id)
    +close(id)
    +context(id) ServerContext
  }
  class Workspace {
    +id: WorkspaceId
    +state: WsState
    +trusted: boolean
    +pr: PullInfo
    +headSha: string
    +mergeBase: string
    +dir: string
    +ctx: ServerContext
    +events: EventEmitter
  }
  class WsState {
    <<enumeration>>
    None
    Fetching
    Ready
    Stale
    Error
  }
  class GitCache {
    +ensureClone(owner, repo)
    +fetch(owner, repo, refspecs)
    +addWorktree(owner, repo, name, sha) string
    +checkout(dir, sha)
    +removeWorktree(dir)
    +mergeBase(owner, repo, a, b) string
    +show(owner, repo, sha, path) string
    +diff(owner, repo, a, b, paths) string
  }
  class WorkspaceStore {
    +load() StoredWorkspace[]
    +save(list)
  }
  class RepoLock {
    +run(key, fn) T
  }
  WorkspaceManager --> Workspace
  WorkspaceManager --> GitCache
  WorkspaceManager --> GitHubClient
  WorkspaceManager --> WorkspaceStore
  GitCache --> RepoLock
  GitCache --> TokenResolver
  GitHubClient --> TokenResolver
  GitHubClient ..> GitHubError
  GitHubError --> GitHubErrorKind
  TokenResolver ..> ResolvedToken
  ResolvedToken --> TokenSource
  Workspace --> WsState
```

- `WorkspaceManager` はサーバに 1 つ。手元のワークスペース（`id = local`）は持たず、既存の `ServerContext` をそのまま使う（REQ-209）
- `RepoLock` は同じ clone への git 操作を直列化する（キー `owner/repo`）。別のリポジトリは並行して動く
- `DDV_HOME`（既定 `~/.ddv`）の配下：`repos/<owner>/<repo>.git`、`worktrees/<owner>/<repo>/<pr-N|ref-名前>`、`reviews/…`、`workspaces.json`

## ワークスペースID

`gh~<owner>~<repo>~pr-<N>` / `gh~<owner>~<repo>~ref-<名前>`。ref 名の `/` は `~~` に置き換える（URL・ファイル名に使うため）。

```mermaid id=open-req code=OPENREQ matrix nswitch=0
flowchart TD
  A[parseOpenRequest] --> B{repo が owner/repo の形式}
  B -->|不適合| E1[400: リポジトリの形式]
  B -->|適合| C{pr と ref のどちらか一方だけある}
  C -->|両方なし・両方あり| E2[400: PR 番号か ref のどちらかを指定]
  C -->|pr| D{pr が 1 以上の整数}
  D -->|いいえ| E3[400: PR 番号の形式]
  D -->|はい| OK1[id: pr]
  C -->|ref| F{ref が安全な名前}
  F -->|いいえ| E4[400: ref の形式]
  F -->|はい| OK2[id: ref]
```

- owner：`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`、repo：`^[A-Za-z0-9._-]{1,100}$` かつ `.` / `..` でない
- 安全な ref 名：`git check-ref-format --branch` を通り、`-` で始まらず、`..`・`~`・制御文字を含まない（git の引数・パスに使うため）
- 同じ ID がすでに開いていれば、新しく作らずそのワークスペースを返す

## 取得

`WorkspaceManager.open` → `fetchJob`。各段階の終わりに `events` へ `progress { step }` を出し、SSE `/api/workspaces/{id}/events` で送る。

```mermaid id=fetch code=FETCH matrix nswitch=0
flowchart TD
  A[fetchJob] --> B{PR か}
  B -->|PR| C[GET pulls/N]
  C --> C1{応答}
  C1 -->|404| E1[Error: PR が見つからない]
  C1 -->|成功| D[ensureClone]
  B -->|ref| C2[GET commits/ref]
  C2 --> C3{応答}
  C3 -->|404| E2[Error: ref が見つからない]
  C3 -->|成功| D
  D --> F{clone 成功}
  F -->|失敗| E3[Error: clone 失敗]
  F -->|成功| G[fetch: head と base]
  G --> H{目的の SHA を取得できた}
  H -->|いいえ| E4[Error: fetch 失敗]
  H -->|はい| I{worktree がある}
  I -->|ある| J[checkout: head SHA]
  I -->|ない| K[addWorktree: head SHA]
  J --> L[mergeBase と createContext]
  K --> L
  L --> R[Ready]
```

| 段階 | git / API |
|---|---|
| ensureClone | 無ければ `git clone --bare --filter=blob:none https://github.com/<o>/<r>.git <repos>/<o>/<r>.git` |
| fetch（PR） | `git fetch --no-tags origin +refs/pull/<N>/head:refs/ddv/pr/<N> +refs/heads/<base>:refs/ddv/base/<base>` |
| fetch（ref） | `git fetch --no-tags origin +<ref>:refs/ddv/ref/<ref>`（branch → tag の順に試す） |
| addWorktree | `git worktree add --detach <worktrees>/<o>/<r>/<name> <sha>` |
| checkout | `git -C <worktree> checkout --detach <sha>`（作業ツリーに変更があれば失敗させる。`.ddv/runs` 等は gitignore で影響しない） |
| mergeBase | `git merge-base <base の SHA> <head の SHA>`（PR のみ） |

- GitHub の応答の `401` は認証エラー（[トークン](#トークン)）、それ以外の失敗は `Error` にして理由を `progress { step: 'error', message }` で送る
- 状態の遷移は :ref[../basic/github-review.md#ワークスペース] の図どおり。`Error` からの再試行は `fetchJob` をやり直す（途中まで作ったものは再利用）
- `createContext(worktree, { watch: false })` で作る（GitHub のワークスペースのファイルは ddv 以外が変えないため監視しない）

### git の実行

```mermaid id=git-seq
sequenceDiagram
  participant M as WorkspaceManager
  participant C as GitCache
  participant L as RepoLock
  participant T as TokenResolver
  participant G as git（子プロセス）
  M->>C: fetch(o, r, refspecs)
  C->>L: run("o/r", fn)
  C->>T: resolve()
  T-->>C: token
  C->>G: spawn("git", args, { env: 認証ヘッダの環境変数 })
  G-->>C: 終了コード・stderr
  C->>C: stderr からトークンを除去
  C-->>M: 成功 / GitError
```

- 認証は `GIT_CONFIG_COUNT=1`・`GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`・`GIT_CONFIG_VALUE_0=Authorization: Basic <base64("x-access-token:" + token)>` の環境変数で 1 コマンドだけに渡す。引数・remote URL・設定ファイルには書かない（REQ-207）
- 常に `GIT_TERMINAL_PROMPT=0`・`GCM_INTERACTIVE=never` を付ける（認証の対話で止まらない）。`spawn` は `shell: false`
- 出力・エラーメッセージは `redact()`（トークンと base64 化した値を `***` に置換）を通してから返す

## トークン

```mermaid id=token code=TOKEN matrix nswitch=0
flowchart TD
  A[resolve] --> B{キャッシュがある}
  B -->|ある| R0[キャッシュを返す]
  B -->|ない| C[gh auth token を実行]
  C --> D{終了コード 0 かつ出力が空でない}
  D -->|はい| G1[source: gh]
  D -->|いいえ| E{GITHUB_TOKEN が空でない}
  E -->|はい| G2[source: env]
  E -->|いいえ| N[source: none]
  G1 --> L[GET /user でログイン名を取得]
  G2 --> L
  L --> M{応答}
  M -->|401| X[none: トークン無効]
  M -->|成功| S[キャッシュして返す]
```

- `gh` が見つからない（`ENOENT`）・5 秒で終わらないときは「いいえ」の扱い
- `GitHubClient` が `401` を受けたら `invalidate()` → `resolve()` で 1 回だけやり直す。それでも `401` なら `GitHubError(auth)`
- `status()` は `{ source, login }` だけを返す（`GET /api/github/auth`）。`token` を持つ `ResolvedToken` は `packages/github` の外へ出さず、`GitHubClient` と `GitCache` だけが使う

## GitHub API

`GitHubClient` は `https://api.github.com` に `Authorization: Bearer`・`Accept: application/vnd.github+json`・`X-GitHub-Api-Version: 2022-11-28` を付けて呼ぶ。テストでは `fetch` を差し替える（コンストラクタ引数）。

```mermaid id=api-error code=APIERR matrix nswitch=0
flowchart TD
  A[応答] --> B{status}
  B -->|2xx| OK[JSON を返す]
  B -->|401| E1[auth]
  B -->|403 / 429| C{x-ratelimit-remaining が 0 または 429}
  C -->|はい| E2[rateLimit: 再開時刻を表示]
  C -->|いいえ| E3[forbidden]
  B -->|404| E4[notFound]
  B -->|422| E5[validation: errors の message を連結]
  B -->|その他| E6[network]
```

- `fetch` 自体の失敗（オフライン等）も `network`。メッセージは GitHub の `message` だけを使い、リクエストのヘッダは含めない
- `paginate` は `Link: rel="next"` をたどる（上限 20 ページ）
- 使うエンドポイント：`GET /user`、`GET /repos/{o}/{r}/pulls`、`GET /repos/{o}/{r}/pulls/{n}`、`GET /repos/{o}/{r}/commits/{ref}`（以降は :ref[review-comment.md#github-api-の対応]）

## API のルーティング

```mermaid id=route-seq
sequenceDiagram
  participant B as ブラウザ
  participant G as guard（Host / Origin）
  participant R as ルータ（/api/w/:ws/*）
  participant M as WorkspaceManager
  participant A as createApp(ctx)（ワークスペースごとにキャッシュ）
  B->>G: POST /api/w/gh~o~r~pr-12/tests/run
  G->>R: 通過
  R->>M: context("gh~o~r~pr-12")
  M-->>R: ServerContext（Ready / Stale のときだけ）
  R->>R: 実行系 API なら trusted を確認
  R->>A: パスを /api/tests/run に書き換えて fetch
  A-->>B: 既存と同じ応答
```

- `/w/:ws/raw/*` も同じく `/raw/*` に書き換える（モックの iframe はこの URL で開く）
- ワークスペースが無い → 404、`Ready` / `Stale` 以外 → 409 `{ code: 'not-ready' }`
- 実行系（`POST tests/run`・`POST snapshots/run`・`POST deps/install`）で `trusted = false` → 403 `{ code: 'untrusted' }`。ビューアはこれを受けて信頼の確認を出す
- GitHub 専用の API（`pr`・`review`・`mock-source`）は書き換えずにサーバ側の `ReviewService` 等が処理する

### 要求の検査

```mermaid id=guard code=GUARD matrix nswitch=0
flowchart TD
  A[要求] --> B{Host が 127.0.0.1 か localhost で port が一致}
  B -->|いいえ| E1[400]
  B -->|はい| C{メソッドが GET / HEAD}
  C -->|はい| OK[通過]
  C -->|いいえ| D{Origin ヘッダがある}
  D -->|ない| F{Sec-Fetch-Site が same-origin か無い}
  F -->|はい| OK2[通過: CLI・テストからの要求]
  F -->|いいえ| E2[403]
  D -->|ある| G{Origin が自身の http://Host と一致}
  G -->|はい| OK3[通過]
  G -->|いいえ| E3[403]
```

- 手元のワークスペースの既存 API にも同じ検査をかける（変更系を外部サイトから呼べないようにする。既存の画面・テストの挙動は変わらない）
- 開発時（`vite` 経由、`5173`）は Origin が違うため、`DDV_DEV_ORIGIN` 環境変数で追加の Origin を許可する

## 依存の導入

PR の worktree は `git worktree add` しただけなので `node_modules` が無く、Vitest / Playwright のランナーを起動できない。GitHub のワークスペースでは、テスト実行の前に依存を確認し、無ければ導入を提案する（:ref[../basic/github-review.md#pr-のコードの実行]）。実装は `apps/server/src/deps.ts`。

```mermaid id=deps code=DEPS matrix nswitch=0
flowchart TD
  A[checkDeps] --> B{Node 系ランナー（vitest / playwright）がある}
  B -->|ない| N1[導入不要]
  B -->|ある| C{ランナーのパッケージを cwd から解決できる}
  C -->|できる| N2[導入不要]
  C -->|できない| D{cwd から repoRoot までにロックファイルがある}
  D -->|pnpm-lock.yaml| P[pnpm install --frozen-lockfile]
  D -->|yarn.lock| Y{.yarnrc.yml がある}
  Y -->|ある| Y2[yarn install --immutable]
  Y -->|ない| Y1[yarn install --frozen-lockfile]
  D -->|bun.lock / bun.lockb| BN[bun install --frozen-lockfile]
  D -->|package-lock.json / npm-shrinkwrap.json| NC[npm ci]
  D -->|ない| E{cwd から repoRoot までに package.json がある}
  E -->|ある| NI[npm install]
  E -->|ない| X[導入できない: problems に理由]
```

- ランナーのパッケージ：`vitest` → `vitest`、`playwright` → `@playwright/test`。`<cwd>/__ddv__.js` 起点の `require.resolve('<pkg>/package.json')` で判定する（ランナーの起動と同じ解決）。`dotnet`・`command` は対象外（`dotnet test` が restore する）
- ロックファイルは cwd に近い順に探す（モノレポで cwd が `apps/web` でも、ルートのロックファイルで導入する）。導入先が同じランナーはまとめる
- 結果：`{ needed, targets: [{ dir, lockfile?, manager, command, args, runners, missing }], problems }`（`dir` はリポジトリ相対）

| API | 動作 |
|---|---|
| `GET /api/deps` | `checkDeps` の結果 |
| `POST /api/deps/install` | `RunManager.startTask('deps')` で `targets` のコマンドを順に実行（失敗したらそこで止める）。202 `{ runId, deps }`。ログは `/api/runs/{runId}/events`。導入後にもう一度 `checkDeps` し、まだ不足があれば `error`。テストの実行中は 409 |
| `POST /api/tests/run` | `ServerContext.checkDeps`（GitHub のワークスペースのみ true）のとき、対象ランナーに不足があれば 409 `{ code: 'deps-missing', deps }` で実行しない。依存の導入中は 409 `{ code: 'deps-installing' }`。手元のワークスペースは確認しない（従来どおり） |

- コマンドはロックファイルから決まる固定の値だけで組み立てる。Windows では `npm` 等が `.cmd` のため shell 経由で起動する。環境変数 `CI=1`（対話の確認を出させない）
- install スクリプト（`postinstall` 等）は通常どおり実行する。信頼済み（`trusted`）のワークスペースだけで、さらに導入ごとにビューアで確認する
- ランナーを起動できなかったとき（パッケージが見つからない等）は、そのランナーに紐づくテストIDの結果を `error`、メッセージを「ランナー <name> を起動できませんでした: <理由>」にする（「紐づくテストが無いか…」は本当に紐づけが無い ID だけ）

ビューア（`DepsDialog`）：`tests/run` が `deps-missing` を返したら開く。

| 項目 | testid | 種類 | 取得元・送信先 | 備考 |
|---|---|---|---|---|
| 導入するコマンド | `deps-targets` | 一覧 | `GET /api/deps` の `targets`（コマンド・導入先・ロックファイル・不足パッケージ）と `problems` | — |
| 導入する | `deps-install` | ボタン | `POST /api/deps/install` → SSE でログを表示 | 成功したら閉じて、拒否されたテスト実行をもう一度送る。失敗したら「再試行」 |
| ログ | `deps-log` | 表示 | SSE `log` | — |
| エラー | `deps-error` | メッセージ | 導入の失敗・API のエラー | — |
| キャンセル / 閉じる | `deps-cancel` | ボタン | 閉じる（テストは実行しない） | 導入中は押せない |

## 更新の検知

- サーバ：`Ready` の PR ワークスペースを `DDV_GITHUB_POLL` 秒ごとに `checkHead`（`GET pulls/N` の `head.sha` と比較）。違えば `Stale` にして `events` に `stale { headSha }`
- ビューア：`window` の `focus` で `POST /api/workspaces/{id}/check` を呼ぶ（30 秒以内の再呼び出しはサーバが前回の結果を返す）
- PR がクローズ・マージされたら PR バーに表示する（状態は変えない。閲覧は続けられる）

## 保存

```json
// ~/.ddv/workspaces.json（トークン・PR の本文は保存しない）
{ "version": 1,
  "workspaces": [
    { "id": "gh~acme~order-app~pr-12", "repo": "acme/order-app", "pr": 12,
      "trusted": false, "headSha": "a1b2c3d…", "openedAt": "2026-10-11T02:00:00Z" } ] }
```

- サーバ起動時に読み込み、worktree が残っているものは `fetchJob` を介さず `Ready`（`headSha` は前回のもの）として復元する。最初の `checkHead` で `Stale` になりうる
- 書き込みは一時ファイル → rename（同時書き込みで壊さない）

## CLI

| 指定 | 動作 |
|---|---|
| `serve --repo <p>` | 従来どおり。`WorkspaceManager` は作るが GitHub には触れない（トークンも解決しない） |
| `serve --github o/r --pr N` | 起動後に `open` を実行し、ブラウザで開く URL を `#/w/<id>/doc` にする |
| `serve --github o/r --pr N`（`--repo` なし） | 手元のワークスペース無し。`/api/config` 等の既存 API は 404 を返し、ビューアは GitHub を開く画面から始める |
| `gh clean [--repo o/r]` | `workspaces.json` に無い worktree を `git worktree remove --force`、`--repo` 指定時は clone も削除 |

## ビューア

- ルート：`#/w/<ws>/doc?path=…` / `#/w/<ws>/tests`（`ws` 省略時は手元）。基本設計の `/w/<ID>/...` はハッシュ内のパスとして実現する
- `api.ts` の各関数はワークスペースの接頭辞（`''` または `/api/w/<ws>` の差分）を受け取る `createApi(ws)` に変える。モックの iframe の URL も `/w/<ws>/raw/...`
- `WorkspaceSwitcher`（ヘッダ）・`OpenDialog`・`LoadingPage`・`PrBar`・`TrustDialog`・`DepsDialog` を追加する。`AppProvider` は `ws` が変わったら状態（文書・実行結果）を読み直す
