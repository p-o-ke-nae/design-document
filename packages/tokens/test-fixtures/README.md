# @ddv/tokens の結合テストの固定ファイル

- `pokenae.Web/app/globals.css` — pokenae.Web（公開リポジトリ）の `app/globals.css` の写し（コミット af81421）。CSS の取り込み（`kind: css`）の確認に使う。
- `repo/desktop/` — 最小の WPF の資源（`App.xaml` と統合する ResourceDictionary、`;component` で参照する別プロジェクト）。サンプルの `examples/sample-app/desktop/OrderApp.Wpf` ができるまでの代わり。
- `expected/` — `ddv tokens generate` の期待する出力。テストは生成結果をこれと比べ、2 回目の生成で内容が変わらないことを確かめる。

期待値を作り直すときは `UPDATE_TOKEN_FIXTURES=1 npx vitest run packages/tokens/src/integration.test.ts` を実行し、差分を確認してからコミットする。
