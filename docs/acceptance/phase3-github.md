# Phase 3（GitHub 連携・PR レビュー）実 GitHub 受入チェックリスト

[要件定義](../design/requirements/github.md) の受入基準（REQ-201〜209）を、実際の GitHub で確かめる手順です。
全項目に結果を記入して合格したら、README のロードマップで Phase 3 を ✅ にします。

> **クローズ記録（2026-10-12）**：実 GitHub での受入確認はせず、受入済みとして Phase 3 をクローズしました。本チェックリストは、後で受入確認をするときのために残しています。

## 準備

- [ ] テスト用リポジトリ `<owner>/<repo>` を用意する（書き込み権限あり）。中身は `examples/sample-app` 一式を push したもの（`ddv.config.yaml`、状態図のある設計書、モック・シナリオ・`e2e/ddv-scenarios.spec.ts` を含む）
- [ ] テスト用 PR を作る：`docs/design/basic/order.md` の状態図に遷移を 1 本追加し、本文を 1 行変更し、front matter を `status: review` にする
- [ ] `gh auth login` 済みで、環境変数 `GITHUB_TOKEN` は未設定にする
- [ ] ddv をビルドする：`npm install` → `npm run build`

| 項目 | 値 |
|---|---|
| 実施日 | |
| 実施者 | |
| ddv のコミット | |
| テスト用リポジトリ / PR 番号 | |

## 手順と判定

| # | 要件 | 手順 | 期待結果 | 結果 |
|---|---|---|---|---|
| 1 | REQ-207 | `npm run ddv -- serve --github <owner>/<repo> --pr <n>` を起動する | `GITHUB_TOKEN` 未設定でも PR が開く | |
| 2 | REQ-201 | 開いた PR の文書を表示し、マトリクスからテストを実行し、モックのシナリオを再生する | PR の head の設計書が表示され、テスト実行（確認ダイアログの後）とモック再生ができる | |
| 3 | REQ-201 | `--repo examples/sample-app` も付けて起動し直し、手元と PR のワークスペースを切り替える。PR に追加コミットを push し「最新化」する | 切替でき、「更新あり」の表示 →「最新化」で追加コミットが反映される | |
| 4 | REQ-202 | 文書ツリーの「変更された文書」と、文書の「差分を表示」を開く | 変更文書に `order.md` が出る。追加した遷移が色分けされ、追加された経路のテストIDが示される。本文の変更行も色分けされる | |
| 5 | REQ-203 | 追加した遷移の 💬 からコメントを保留に追加し、「レビュー（1）」から Comment で送信する | GitHub の PR で、その遷移を定義した行にコメントが付く | |
| 6 | REQ-203 | GitHub 上で別の行にコメントを付け、ddv を最新化する。そのスレッドに ddv から返信し、「解決済みにする」を押す | ddv の該当要素の後ろにスレッドが出る。返信が GitHub に反映され、GitHub 上でも解決済みになる | |
| 7 | REQ-204 | コメントを 3 件保留し、「レビュー（3）」で 1 件削除して Request changes で送信する | GitHub に 2 件のコメント付きの変更要求レビューが 1 つだけ作られる | |
| 8 | REQ-206 | モックの「調整」でボタンの文言と入力欄の maxlength を変更し、それぞれ「保留に追加」して Comment で送信する | モックに即反映される。PR のモック HTML の該当行に suggestion が 2 件付き、GitHub の「Commit suggestion」で取り込める | |
| 9 | REQ-205 | 「レビュー」で Approve を選び、`order.md` にチェックを入れて送信する | PR のブランチに `order.md` を `status: approved` にするコミットが追加され、ddv の文書に Approve 済みの表示が出る | |
| 10 | REQ-205 | 書き込み権限の無いアカウント（またはフォークからの PR）で 9 を行う | コミットの代わりに `status` 行への suggestion が付く | |
| 11 | REQ-208 | AI エージェントで `ddv-review-response` スキルを使い、手順 5〜7 のコメントに対応させる（`ddv review comments --github <owner>/<repo> --pr <n> --json`） | 修正がコミット・push され、各コメントに返信が付く。承認済み文書への指摘は修正せず人間に確認してくる | |
| 12 | REQ-207 | 手順 1〜11 の間のブラウザの開発者ツールの通信、サーバのログ、`.ddv/` と `DDV_HOME` 配下のファイルを、トークン文字列（`gh auth token` の出力）で検索する | どこにもトークンが含まれない | |
| 13 | REQ-209 | ネットワークを切断し、gh 未ログイン・`GITHUB_TOKEN` 未設定の状態で `npm run ddv -- serve --repo examples/sample-app` を起動する | Phase 2 までの機能（閲覧・マトリクス・テスト実行・モック再生・スナップショット）がすべて動く | |

## 片付け

- [ ] `npm run ddv -- gh clean --repo <owner>/<repo>` で worktree・clone を削除する
- [ ] テスト用 PR を閉じる（必要ならテスト用リポジトリも削除する）

## 不合格だったとき

- 不具合として Issue を起こし、修正後に該当の手順だけをやり直す
- 要件や受入基準の見直しが必要なら、承認済みの要件定義を直接書き換えず、人間に差し戻しを相談する
