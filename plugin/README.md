# ddv プラグイン（AI エージェント用）

ddv（Design Doc Viewer）の規約に沿って、AI エージェントが要件定義・基本設計・詳細設計を作るためのスキルとテンプレート。
GitHub Copilot CLI と Claude Code の両方で同じスキル（`skills/*/SKILL.md`）を使う。

## 構成

```
plugin/
  plugin.json                 Copilot CLI 用（Agent Plugins 1.0）
  .claude-plugin/plugin.json  Claude Code 用
  skills/
    ddv-requirements/         目的→As-Is→課題→To-Be→スコープ→受入基準 の順にヒアリング
    ddv-basic-design/         画面遷移/状態図/シーケンス/ER/全画面モック、テストID採番、シナリオ骨組み生成、lint
    ddv-detailed-design/      クラス図/シーケンス/単体レベル状態図、モックの疑似API・fixtures、テストID採番、lint
    ddv-review-response/      PR のレビューコメントを ddv review comments で取り込み、設計書・モックを直して返信（解決はレビュアー）
  templates/                  対象リポジトリと同じ配置のひな形（そのまま ddv lint が通る）
    ddv.config.yaml
    docs/design/{requirements,basic,detailed}/sample.md
    docs/mocks/sample/          全画面モック（index.html）・疑似API（api.yaml）・fixtures・実アプリ用の対応表（scenarios/_map.yaml）
    e2e/ddv-hooks.ts            実アプリで E2E を実行するときのデータ投入・独自操作（任意）
    .github/workflows/ddv-tests.yml  ビューアから Actions でテストを実行するワークフロー（任意。ddv actions init で配置）
```

## 前提

スキルは ddv の CLI を `DDV_HOME`（ddv リポジトリのクローン先）経由で呼ぶ。

```powershell
git clone <ddv のリポジトリ> C:\tools\ddv
cd C:\tools\ddv; npm install; npm run build
[Environment]::SetEnvironmentVariable('DDV_HOME', 'C:\tools\ddv', 'User')
```

```sh
export DDV_HOME=~/tools/ddv
```

## インストール

### GitHub Copilot CLI

```sh
copilot plugin install ./plugin     # ddv リポジトリのルートで
copilot plugin list                 # 確認。セッション内では /skills list
```

インストール時にキャッシュされるため、スキルを更新したら再度 `install` する。
プラグインを使わない場合は `skills/` 配下を `~/.copilot/skills/`（全リポジトリ）か対象リポジトリの `.github/skills/` にコピーし、
`templates/` もスキルから `../../templates/` で参照できる位置に置く。

### Claude Code

```sh
claude --plugin-dir ./plugin        # 開発中の読み込み
```

マーケットプレイス経由で配布する場合は、このディレクトリを含むリポジトリを `/plugin marketplace add` で登録する。
プラグインを使わない場合は `skills/` 配下を `~/.claude/skills/` か対象リポジトリの `.claude/skills/` にコピーする。

## 使い方（工程とゲート）

| 工程 | 誰が | スキル / 操作 | ゲート |
|---|---|---|---|
| 要件定義 | 人間＋AI（plan モード） | `ddv-requirements` | 人間が ddv で確認し `status: approved` |
| 基本設計 | AI | `ddv-basic-design` | 図・マトリクスとモックのプレイヤーで全経路をレビューし承認（＝テストケース承認） |
| 詳細設計 | AI | `ddv-detailed-design` | 同上 |
| レビュー対応 | AI | `ddv-review-response`（`ddv review comments --github <o/r> --pr <n> --json` でスレッドを取得し、修正・push・返信） | 解決はレビュアー。承認済み文書への指摘は人間に確認 |
| 実装 | AI（TDD） | テストIDをテスト名/Trait に書いて全グリーンまで。画面経路の E2E はシナリオ YAML を `_map.yaml` で実アプリに向けて実行 | ddv のテストタブで結果確認 |
| 受入 | 人間 | 要件の受入基準を ddv で確認 | 完了 |

レビューは対象リポジトリで `npm --prefix "$DDV_HOME" run ddv -- serve --repo <対象の絶対パス>` を起動し、http://127.0.0.1:5178 で行う。

## Actions でテストを実行する（任意）

ビューア（Pages 版・ローカル版）から、対象リポジトリの GitHub Actions でテスト・スナップショット・トレースを実行できる。
結果は対象リポジトリの `ddv-results` ブランチに保存される。

1. 雛形を配置する（どちらか）
   ```sh
   npm --prefix "$DDV_HOME" run ddv -- actions init --repo <対象の絶対パス>
   ```
   または `templates/.github/workflows/ddv-tests.yml` を対象の `.github/workflows/` にコピーする
2. `env` の `DDV_REF`（ddv のタグ）と保持件数（`DDV_MAX_RUNS`・`DDV_MAX_DAYS`・`DDV_MAX_TRACE_RUNS`）、証跡の上限（`DDV_EVIDENCE_MAX_BYTES`・`DDV_EVIDENCE_MAX_TOTAL`）を必要なら直し、
   証跡で DB を使うときは接続文字列を secret に置き、コメントの例（`DDV_DB_APP`）に倣って `env` に渡す。
   .NET など npm 以外の依存があれば「対象の依存を導入」の後に step を足す
3. コミットして **既定ブランチへマージ** する（既定ブランチに無いとビューアから起動できない）。
   既存の PR のブランチは既定ブランチを取り込む
4. `ddv-results` ブランチはブランチの保護（ルールセット）の対象にしない（ワークフローが毎回強制 push する）
5. 基準画像の承認のコミットで PR の CI を動かしたいときは、contents: write の PAT（または GitHub App のトークン）を
   リポジトリの secret `DDV_PUSH_TOKEN` に置く
6. ビューアのテストタブ →「Actions」→「Actionsで実行」。Pages 版は Actions: Write を持つ fine-grained PAT が要る

## デスクトップアプリ・デザインのトークン・証跡（任意）

`ddv.config.yaml` の書き方は `templates/ddv.config.yaml` のコメントの例を参照。

- **デスクトップアプリ（WPF・WinForms）**：`runners` に `type: flaui` を足すと、画面の経路のシナリオを FlaUI で実アプリに対して実行する（Windows・.NET 8 以上の SDK が要る）
  - 確認：`npm --prefix "$DDV_HOME" run ddv -- desktop doctor --repo <repo>`、実行：`ddv -- desktop run --runner <name> --repo <repo>`
  - `_map.yaml` の `wpf:`・`winforms:` 節に AutomationId の対応を書く。プラットフォームだけの補助ステップは `only: [wpf]`
  - 画面定義（XAML・`*.Designer.cs`）に AutomationId が無いと `ddv-lint` が指摘する
  - Actions では windows のランナーで `setup-dotnet` の後に `ddv desktop run --junit ...` を実行する
- **デザインのトークン**：`tokens` に実アプリの XAML・CSS を指定し、`npm --prefix "$DDV_HOME" run ddv -- tokens generate --repo <repo>` で
  モックが読む CSS を生成する。元が変わって生成物が古いと `ddv-lint` が指摘する
- **証跡**：シナリオのステップに `evidence:`（`use: screenshot` / `db` / `command` / hooks の名前）を書くと、実行時に画面・表・ログを保存し、トレースから開ける
  - DB・外部コマンドは `evidence.databases`・`evidence.commands` に、独自の取得は `e2e/ddv-hooks.ts` の `export const evidence` に書く
  - 一覧：`ddv -- evidence list --repo <repo>`、1 件だけ試す：`ddv -- evidence try ...`。DB は読み取りの SQL だけ通す
## 今後の拡張（ロードマップ）

- `ddv-tdd-implement`（承認済みIDからテスト先行で実装、`ddv-testid check --strict` で網羅確認）
- `ddv-change-request`（実装中の設計差し戻し）
