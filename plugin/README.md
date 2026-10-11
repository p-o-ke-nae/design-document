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

## 今後の拡張（ロードマップ）

- `ddv-tdd-implement`（承認済みIDからテスト先行で実装、`ddv-testid check --strict` で網羅確認）
- `ddv-change-request`（実装中の設計差し戻し）
