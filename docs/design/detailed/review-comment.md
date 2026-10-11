---
id: REVCMT
kind: detailed
status: approved
title: PR 差分・レビューコメント 詳細設計
traces: [BD-GHREV]
---

# PR 差分・レビューコメント 詳細設計

## 前提

- 振る舞いは :ref[../basic/github-review.md#pr-の差分]、:ref[../basic/github-review.md#コメント]、:ref[../basic/github-review.md#approve-時の-status-連動] を参照
- ワークスペース・GitHub クライアントは :ref[workspace.md#構造] を参照
- サーバは `apps/server/src/review.ts`（`ReviewService`・`PendingStore`）・`pr-diff.ts`（`DiffService`）・`threads.ts`、ソース位置は `packages/core`・`packages/graph` に追加する

## 画面

画面遷移は :ref[../basic/github-review.md#画面遷移]。このうち「PR の文書（本文・差分）」「保留中レビュー」「送信済」を扱う。

::mock[github-review/index.html]

| 項目 | testid | 種類 | 型・桁 | 必須 | 初期値 | 取得元・送信先 | 入力チェック・エラー文言 |
|---|---|---|---|---|---|---|---|
| PR バー | `prbar` | 表示 | — | — | — | `GET /api/w/<ws>/pr`（番号・タイトル・base ← head） | — |
| head の SHA | `head-sha` | 表示 | 7 桁 | — | — | ワークスペースの `headSha` | — |
| 更新あり | `stale` | 表示 | — | — | 非表示 | SSE `stale` | — |
| 最新化 | `refresh` | ボタン | — | — | — | `POST /api/workspaces/<ws>/refresh` → 取得中 → `relocate` | — |
| レビュー状態 | `review-state` | 表示 | — | — | — | `GET /api/w/<ws>/reviews`（レビュアーごとの最新） | — |
| 保留件数 | `pending-count` | 表示 | 数値 | — | 0 | `PendingReview.comments.length` | — |
| 変更された文書 | `changed-docs` | ツリー | — | — | — | `DiffService.files`（A / M / D） | — |
| 差分 | `diff-view` | 表示切替 | — | — | 閉 | `DiffService.docDiff` | — |
| テストIDの増減 | `id-changes` | 一覧 | — | — | — | `DocDiff.ids`（追加・欠番） | — |
| スレッド | `thread` | 表示 | — | — | — | `ThreadService.list`（未解決を先に） | — |
| 場所 | `anchor` | 選択 | — | ○ | 💬 を押した要素 | `Anchor`（:ref[#ソース位置]）。差分外ならファイルコメントと表示 | — |
| コメント | `comment` | テキスト（複数行） | 文字列 2000 | ○ | 空 | `POST /api/w/<ws>/review/comments` の `body` | 空：「コメントを入力してください」 |
| コメントのエラー | `comment-error` | メッセージ | — | — | 非表示 | `422` の `message` | — |
| 保留に追加 | `add-comment` | ボタン | — | — | — | `ReviewService.add` | — |
| レビュー | `to-review` | ボタン | — | — | — | 保留中レビューへ | — |
| 保留中のコメント | `pending` | 一覧 | — | — | — | `ReviewService.get`（`Drifted` は警告色。修正・削除・移動） | — |
| 種類 | `event` | 選択 | `COMMENT` / `APPROVE` / `REQUEST_CHANGES` | ○ | `COMMENT` | `submit` の `event` | — |
| 本文 | `body` | テキスト（複数行） | 文字列 5000 | Comment・Request changes で ○ | 空 | `submit` の `body` | 空：「Comment / Request changes には本文が必要です」 |
| status を approved にする | `approve-status` | チェック（文書ごと） | — | — | オフ | `submit` の `approveDocs` | `APPROVE` 以外では無効（:ref[#status-連動]） |
| 送信のエラー | `submit-error` | メッセージ | — | — | 非表示 | `SubmitResult.failed` / GitHub の理由 | `Drifted` が残る：「位置を確認していないコメントがあります」 |
| 送信 | `review-submit` | ボタン | — | — | — | `ReviewService.submit`（:ref[#送信]） | — |
| 閉じる | `review-close` | ボタン | — | — | — | PR の文書へ | — |
| 結果 | `done-message` | 表示 | — | — | — | `SubmitResult.posted`・`statusCommit` | 一部失敗は件数と理由 |
| レビューの URL | `review-url` | リンク | — | — | — | `SubmitResult.reviewUrl` | — |
| PR に戻る | `back-to-pr` | ボタン | — | — | — | PR の文書へ（スレッドを取り直す） | — |
## 構造

```mermaid id=class
classDiagram
  class ReviewService {
    +get(ws) PendingReview
    +add(ws, input) PendingComment
    +update(ws, id, patch) PendingComment
    +remove(ws, id)
    +relocate(ws, newHead)
    +submit(ws, event, body, approveDocs) SubmitResult
  }
  class PendingStore {
    +read(owner, repo, pr) PendingReview
    +write(owner, repo, pr, review)
  }
  class PendingReview {
    +headSha: string
    +comments: PendingComment[]
  }
  class PendingComment {
    +id: string
    +anchor: Anchor
    +body: string
    +suggestion?: string
    +state: CommentState
    +placement: Placement
    +commitId: string
  }
  class Anchor {
    +path: string
    +side: Side
    +startLine: number
    +line: number
    +lineText: string[]
    +element: ElementRef
  }
  class ElementRef {
    +kind: ElementKind
    +key: string
    +label: string
  }
  class ElementKind {
    <<enumeration>>
    block
    tableRow
    node
    edge
    diagram
    matrixRow
    mockElement
  }
  class CommentState {
    <<enumeration>>
    Pending
    Drifted
  }
  class Placement {
    <<enumeration>>
    line
    file
  }
  class Hunks {
    +parse(unifiedDiff) Hunks
    +contains(side, start, end) boolean
    +addedLines() Set
  }
  class DiffService {
    +files(ws) ChangedFile[]
    +docDiff(ws, path) DocDiff
  }
  class ThreadService {
    +list(ws, path) Thread[]
    +reply(ws, threadId, body)
    +resolve(ws, threadId, resolved)
  }
  class StatusCommitter {
    +commit(ws, paths) string
  }
  ReviewService --> PendingStore
  ReviewService --> Hunks
  ReviewService --> StatusCommitter
  PendingReview --> PendingComment
  PendingComment --> Anchor
  PendingComment --> CommentState
  PendingComment --> Placement
  Anchor --> ElementRef
  ElementRef --> ElementKind
  DiffService --> Hunks
  ThreadService ..> Anchor
```

- `Side` は `RIGHT`（head）/ `LEFT`（merge-base）。`lineText` は `startLine..line` の各行の内容（付け直しに使う）
- `ElementRef.key` の例：見出しのスラッグ、`<図ID>#node:<状態ID>`、`<図ID>#edge:<GraphEdge.key>`、テストID、モック要素のパス（:ref[mock-tune.md#要素のパス]）
- `PendingStore` は `DDV_HOME/reviews/<owner>/<repo>/pr-<N>.json`。書き込みは一時ファイル → rename

## ソース位置

ビューアの要素 → ファイルの行（1 始まり）。描画側は `DocResponse` に追加する位置情報だけを使い、行の計算はサーバで行う。

| 追加するもの | 内容 |
|---|---|
| `ParsedDoc.blocks` | remark の最上位ブロックごとに `{ type, line, endLine }`。リストは項目ごと、表は行ごと（`tableRow`、ヘッダ・区切り行を含めて 1 行 = 1 要素） |
| `GraphNode.line` / `GraphEdge.line` | 図のコード内の行（1 始まり）。ノードは `state "…" as X` / `X[…]` の定義行、無ければ最初に現れた行 |
| ファイル行への変換 | `DiagramBlock.line`（開始フェンス）+ コード内の行 |

```mermaid id=anchor code=ANCHOR matrix nswitch=0
flowchart TD
  A[toAnchor] --> B{要素の種類}
  B -->|block / tableRow| L1[ブロックの行範囲]
  B -->|node / edge| C{要素に line がある}
  C -->|ある| L2[フェンス行 + line の 1 行]
  C -->|ない| L3[図全体: フェンスの開始〜終了行]
  B -->|diagram| L3
  B -->|matrixRow| L4[フェンスの開始行の 1 行。本文にテストIDと経路を引用]
  B -->|mockElement| L5[モック HTML の要素の行範囲]
  L1 --> P[配置の判定へ]
  L2 --> P
  L3 --> P
  L4 --> P
  L5 --> P
```

### 配置の判定

```mermaid id=place code=PLACE matrix nswitch=0
flowchart TD
  A[placement] --> B{ファイルが PR で変更されている}
  B -->|いいえ| F1[body: レビュー本文に path・L行・内容を引用して含める]
  B -->|はい| C{startLine..line が 1 つの hunk の side 側の範囲に収まる}
  C -->|はい| L[line: 複数行なら start_line も付ける]
  C -->|いいえ| D{line だけなら hunk に収まる}
  D -->|はい| L2[line: line の 1 行に縮める。suggestion は付けない]
  D -->|いいえ| F2[file: 本文に L行と内容を引用]
```

- `Hunks` は `git diff --unified=3 <mergeBase> <head> -- <path>` を解析する（GitHub の差分と同じ文脈 3 行）。`side` の範囲は `RIGHT` = `+c,d`、`LEFT` = `-a,b`
- suggestion 付きで「line に縮める」場合は suggestion が範囲とずれるため、`file` にする（suggestion の行範囲は変えない）
- PR の差分に無いファイルは、GitHub がファイルへのコメント（`subject_type: file`）を受け付けず（422 `could not be resolved`）、行コメントも付けられない。そのため `body`（レビュー本文に含める）とする。送信時はレビュー本文の末尾に `**path**` と引用・コメントを区切り線（`---`）つきで並べ、レビュー作成と同時に送るので、一部だけ失敗することは無い。スレッドにならないため返信・解決はできない
- 判定は追加時と `relocate` 後に行い、`placement` として保存する（一覧の区別表示に使う）

## 付け直し

`ReviewService.relocate(ws, newHead)`：最新化で head が変わったとき、`state = Pending` のコメントごとに行う。

```mermaid id=relocate code=RELOC matrix nswitch=0
flowchart TD
  A[relocate] --> B{新しい head にファイルがある}
  B -->|ない| D1[Drifted: ファイルが削除された]
  B -->|ある| C{同じ行番号の内容が lineText と一致}
  C -->|一致| K[そのまま。commitId を更新]
  C -->|不一致| E{lineText と一致する連続行がある}
  E -->|ない| D2[Drifted: 内容が変わった]
  E -->|1 か所| M[その位置へ移動]
  E -->|複数| N[元の行に最も近い位置へ移動]
  K --> P[配置の判定をやり直す]
  M --> P
  N --> P
```

- `LEFT`（削除行）のコメントは merge-base が変わらなければそのまま、変わったら同じ手順を merge-base に対して行う
- `Drifted` は送信対象外。`update(ws, id, { anchor })` で位置を選び直すと `Pending` に戻る

## 送信

```mermaid id=submit-seq
sequenceDiagram
  participant R as ReviewService
  participant C as StatusCommitter
  participant M as WorkspaceManager
  participant H as GitHubClient
  R->>R: 検査（Drifted なし・本文の要否。基本設計の送信の図）
  opt Approve で status 更新あり
    R->>C: commit(ws, paths)
    C-->>R: 新しい head SHA（または suggestion に切替）
    R->>M: refresh(ws)（新しい head へ）
  end
  R->>H: POST /repos/o/r/pulls/N/reviews
  H-->>R: review id, html_url
  loop placement = file
    R->>H: POST /repos/o/r/pulls/N/comments（subject_type: file）
    R->>R: 成功した分を保留から削除して保存
  end
  R-->>R: SubmitResult
```

```mermaid id=post code=POST matrix nswitch=0
flowchart TD
  A[レビュー作成] --> B{成功}
  B -->|422| E1[失敗: 保留はすべて残す。GitHub の理由を表示]
  B -->|その他の失敗| E2[失敗: 保留はすべて残す]
  B -->|成功| C[line のコメントを保留から削除]
  C --> D{file のコメントが残っている}
  D -->|ない| OK[完了]
  D -->|ある| F[1 件投稿]
  F --> G{成功}
  G -->|成功| H[保留から削除]
  G -->|失敗| P[一部失敗: 残りを保留に残し理由を表示]
  H --> D
```

- 要求の組み立て：`{ commit_id: head, event, body, comments: [{ path, body, line, side, start_line?, start_side? }] }`
- suggestion は本文の末尾に ```` ```suggestion ```` ブロックで付ける（`startLine..line` を置き換える内容）
- ファイルコメント：`{ commit_id: head, path, body, subject_type: "file" }`。本文の先頭に `> L12: <行の内容>`（複数行は `L12-14`）
- `SubmitResult`：`{ reviewUrl, posted: { line, file }, failed: [{ id, message }], statusCommit? }`

## status 連動

```mermaid id=commit-seq
sequenceDiagram
  participant C as StatusCommitter
  participant H as GitHubClient
  participant W as worktree
  C->>H: GET /repos/{ho}/{hr}/git/ref/heads/{headRef}
  H-->>C: sha
  alt sha が ws.headSha と違う
    C-->>C: 中止（最新化してやり直す）
  end
  loop 文書ごと
    C->>W: ファイルを読む
    C->>C: setStatus(text, "approved")
    C->>H: POST git/blobs
  end
  C->>H: POST git/trees { base_tree: head の tree, tree: [...] }
  C->>H: POST git/commits { message, tree, parents: [headSha] }
  C->>H: PATCH git/refs/heads/{headRef} { sha, force: false }
  H-->>C: 新しい head SHA
```

- `{ho}/{hr}` は PR の head リポジトリ（フォークの PR ではフォーク側）。書けるかは `pr.head.repo.permissions.push` または `pr.maintainer_can_modify`
- `PATCH` が `422`（fast-forward でない）なら中止して `stale` 扱い
- 書けないときは、各文書の `status:` 行への suggestion コメント（配置の判定に従い、差分外ならファイルコメントで変更内容を記載）を保留に追加してから送信する

```mermaid id=set-status code=SETST matrix nswitch=0
flowchart TD
  A[setStatus] --> B{先頭が --- の front matter}
  B -->|ない| S1[変更なし: 警告を返す]
  B -->|ある| C{status: の行がある}
  C -->|ない| I[閉じる --- の直前に status 行を追加]
  C -->|ある| D{値がすでに approved}
  D -->|はい| S2[変更なし]
  D -->|いいえ| R[その行の値だけを置換。改行コードは元のまま]
```

- 行の書き換えだけで YAML を再出力しない（コメント・キーの順・引用符を保つ）

## スレッド

| 操作 | GitHub |
|---|---|
| 一覧 | GraphQL `pullRequest(number).reviewThreads(first: 100)`：`id`・`isResolved`・`isOutdated`・`path`・`line`・`startLine`・`diffSide`・`comments(first: 50) { databaseId author { login } body createdAt url }` |
| 返信 | REST `POST /repos/o/r/pulls/N/comments/{先頭コメントの databaseId}/replies` |
| 解決 / 未解決 | GraphQL `resolveReviewThread` / `unresolveReviewThread`（`threadId`） |
| ファイルコメント | `line` が null（`subjectType: FILE`）。文書の先頭に表示する |

```mermaid id=thread-anchor code=THREAD matrix nswitch=0
flowchart TD
  A[スレッド] --> B{path が表示中の文書}
  B -->|いいえ| X[対象外]
  B -->|はい| C{line がある}
  C -->|ない| F[文書の先頭: ファイルのコメント]
  C -->|ある| D{isOutdated}
  D -->|はい| O[文書の先頭: 古い位置のコメントとして表示]
  D -->|いいえ| E{line を含む最小の要素がある}
  E -->|ある| H[その要素に表示]
  E -->|ない| F
```

- 「最小の要素」は、図の node / edge → 表の行・ブロック → 図全体 の順に、行範囲が `line` を含むもの
- スレッドは `ws` ごとに 30 秒キャッシュし、返信・解決・送信の後は捨てる

## PR の差分

```mermaid id=diagram-match code=DGMATCH matrix nswitch=0
flowchart TD
  A[head の図] --> B{id がある}
  B -->|ある| C{base に同じ id の図がある}
  C -->|ある| P1[対応: diffGraphs]
  C -->|ない| N1[追加]
  B -->|ない| D{base の id 無しの図に同じ順番のものがある}
  D -->|ある| P2[対応: diffGraphs]
  D -->|ない| N2[追加]
```

- base 側に対応の無い図は「削除」。`parseMermaidGraph` が解析できない図（シーケンス図等）は、ソースの行差分だけを示す
- 図が「変更」か「変更なし」かは、改行（CRLF / LF）と行末の空白を正規化して比べる（base は git の blob で LF、head は作業ツリーで autocrlf により CRLF のことがあるため）。それ以外の文字の違いは「変更」
- 本文：`Hunks.addedLines()` を含む head のブロックを追加・変更、base で削除行だけからなるブロックを削除ブロックとして、直後の head のブロックの前に入れる
- テストIDの増減：`git show <mergeBase>:.ddv/testids.lock.json` と head のロックを比べ、図ごとに `active` のIDの差（追加・欠番化）を返す。base にロックが無ければ全部追加
- `DocDiff`：`{ status: A/M/D/R, oldPath?, blocks: [{ line, endLine, change }], removed: [{ beforeLine, markdown }], diagrams: { [id]: { change, diff? } }, ids: { added: [], retired: [] } }`

## GitHub API の対応

| 用途 | エンドポイント |
|---|---|
| PR 情報・権限 | `GET /repos/o/r/pulls/N` |
| レビュー一覧（状態バッジ） | `GET /repos/o/r/pulls/N/reviews`（レビュアーごとに最新の `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`） |
| レビュー作成 | `POST /repos/o/r/pulls/N/reviews` |
| ファイルコメント・返信 | `POST /repos/o/r/pulls/N/comments`、`.../comments/{id}/replies` |
| スレッド・解決 | GraphQL `reviewThreads`・`resolveReviewThread`・`unresolveReviewThread` |
| status 連動 | `GET git/ref`・`POST git/blobs`・`POST git/trees`・`POST git/commits`・`PATCH git/refs` |

## CLI：review comments

`ddv review comments --github o/r --pr N [--json] [--all]`：未解決のスレッド（`--all` で全部）を出力する。ワークスペースが無ければ取得してから行う。

```json
{ "pr": 12, "headSha": "a1b2c3d",
  "threads": [
    { "id": "PRRT_…", "url": "https://github.com/…", "resolved": false, "outdated": false,
      "path": "docs/design/basic/order.md", "line": 42, "startLine": null,
      "doc": { "id": "ORDER", "status": "review", "heading": "画面遷移" },
      "element": { "kind": "edge", "key": "screen-flow#edge:Confirm|戻る|Input", "label": "確認 → 入力 : 戻る" },
      "testIds": ["BD-ORDER-SCREEN-T009"],
      "suggestion": null,
      "comments": [{ "id": 101, "author": "alice", "body": "…", "createdAt": "…" }] } ] }
```

- `suggestion` は先頭コメントの ```` ```suggestion ```` ブロックの中身（無ければ null）。`testIds` は element を通る経路のテストID（`pathsThrough`）
- `--json` なしは、文書・見出しごとにまとめた人向けの一覧
