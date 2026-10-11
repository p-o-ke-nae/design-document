---
name: ddv-review-response
description: GitHub の PR に付いたレビューコメント（スレッド）を ddv review comments で取り込み、指摘された設計書・モックを直してコミット・push し、各スレッドに対応内容を返信する。解決（resolve）はレビュアーに任せる。「PR のレビューに対応して」と頼まれたときに使う。
---

# ddv レビュー対応

入力：対象の PR（`<owner/repo>` と PR 番号）。
出力：設計書・モックの修正コミット、各スレッドへの返信、人間への対応一覧。

## 手順

1. 未解決スレッドを取得する（ワークスペースが無ければ ddv が取得する。`gh` 認証または `GITHUB_TOKEN` が必要）

   ```sh
   npm --prefix "$DDV_HOME" run ddv -- review comments --github <owner/repo> --pr <n> --json
   ```

   `--all` で解決済みも含める。`--json` なしは人向けの一覧（文書・見出しごと）
2. 出力のスレッドごとに、対象を特定する
   - `path` / `line`：該当ファイルと行。`doc` は文書（`id` / `status` / `heading`）
   - `element`：指摘された図の node / edge、表の行、ブロック。`null` はファイルへのコメント（文書全体）
   - `testIds`：その要素を通る経路のテストID。図を直すと影響を受けるテストの目安
   - `outdated: true`：コメント後に行が変わっている。現在の文書で該当箇所を探す
   - `suggestion`：先頭コメントの suggestion ブロックの中身（行の置き換え案）
3. ローカルの対象リポジトリで PR のブランチをチェックアウトして作業する
4. スレッドごとに対応する
   - `suggestion` あり：内容を `path` の `startLine`〜`line`（`startLine` が null なら `line` の1行）にそのまま適用する
   - 指摘のみ：設計書・モックを修正する。図を直したら `ddv-testid generate`、画面経路が変わるなら `ddv mock scaffold` まで行う
   - 判断が要る・意図が読み取れない指摘：直さず、人間に確認する
5. `npm --prefix "$DDV_HOME" run ddv-lint -- --repo <repo>` を error 0 まで
6. コミットして PR のブランチへ push する
7. 各スレッドに、対応内容（コミットの SHA・直した箇所・直さなかった理由）を返信する

   ```sh
   gh api -X POST repos/<owner>/<repo>/pulls/<n>/comments/<先頭コメントの id>/replies -f body="<対応内容>"
   ```

   `comments[0].id` が返信先の ID
8. 人間に、対応一覧（スレッド ID / URL・対応内容）と、判断を仰ぎたい指摘を報告する

## 禁止

- **`status: approved` の文書への指摘は、修正せず人間に確認する**（承認済みの要件定義・基本設計・詳細設計を勝手に書き換えない。差し戻しの要否は人間が決める）
- **スレッドを解決（resolve）しない**。解決はレビュアーが行う。返信までにする
- `.ddv/testids.lock.json` を手で編集しない
- 指摘に無い箇所を直さない（見つけた別の問題は、報告に書くだけにする）
