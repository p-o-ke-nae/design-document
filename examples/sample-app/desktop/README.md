# 注文受付のデスクトップのサンプル（WPF・WinForms）

`docs/mocks/order/index.html`（モック）と同じ画面・遷移を、WPF と WinForms で作ったサンプルです。
ddv の `type: flaui` のランナーで、`docs/mocks/order/scenarios/*.yaml` を **テストコードを書かずに** そのまま実行する対象にします
（設計：`docs/design/basic/desktop-run.md`、`docs/design/detailed/flaui-driver.md`、`docs/design/detailed/desktop-scenario.md`）。

## 構成

| プロジェクト | 内容 |
|---|---|
| `OrderApp.Core` | 画面遷移（`OrderFlow`）・入力チェック・疑似 API と同じデータ（`OrderStore`）・fixtures の読み込み（`FixtureData`）。`../dotnet/OrderDomain` の `Order` で注文を確定する |
| `OrderApp.Wpf` | WPF のアプリ。`MainViewModel` と、画面ごとの `UserControl`（`Views/*.xaml`） |
| `OrderApp.WinForms` | WinForms のアプリ。画面ごとの `UserControl`（`Screens/*.Designer.cs`） |
| `OrderApp.Desktop.Tests` | xUnit の単体テスト（`OrderFlow`・`FixtureData`・`MainViewModel`）。画面遷移のテストは `[Trait("TestId", "BD-ORDER-SCREEN-…")]` |

## ビルドと実行

.NET 8 以上の SDK（Windows）が必要です。

```powershell
cd examples/sample-app/desktop
dotnet build OrderApp.Desktop.slnx
dotnet test OrderApp.Desktop.slnx
# 起動
.\OrderApp.Wpf\bin\Debug\net8.0-windows\OrderApp.Wpf.exe
.\OrderApp.WinForms\bin\Debug\net8.0-windows\OrderApp.WinForms.exe
```

`../dotnet/OrderDomain` は `net10.0;net8.0` の両方でビルドします（既存の `dotnet` ランナーは従来どおり `net10.0` で動きます）。

## 初期データ（fixtures）

ddv はシナリオごとにアプリを起動し直し、環境変数 `DDV_FIXTURES` に、シナリオの `fixtures` を結合した JSON のファイルのパスを渡します
（`docs/design/detailed/flaui-driver.md#fixtures-のファイル`）。アプリは起動時にそのファイルを読みます。

```json
{ "scenario": "BD-ORDER-SCREEN-P001", "fixtures": ["default"],
  "tables": { "orders": [ { "id": 1, "customer": "佐藤 花子", "sku": "A-100", "quantity": 2, "status": "Submitted" } ],
              "stock":  [ { "sku": "A-100", "qty": 10 } ] } }
```

- 使うテーブルは `orders`（一覧）と `stock`（在庫。確定時に数量より少なければ「在庫が不足しています」）。モックと同じく、ファイルに無いテーブルは空、`stock` に無い商品は在庫 0 とみなします
- 手で起動するときは引数 `--fixtures <path>` でも指定できます（環境変数より優先）
- どちらも無ければ、`docs/mocks/order/fixtures/default.yaml` と同じ内容の既定のデータで起動します
- ファイルが読めない・形式が違うときは、標準エラーに理由を書いて終了コード 2 で終わります（ウィンドウは出ません。`DDV_SCENARIO` が無い、つまり手で起動したときはメッセージボックスも出します）

## 論理名と名前

シナリオの論理名（画面の状態ID・`click`・`input`・`expect` のキー）は、UI Automation の AutomationId と同じにしてあります。
そのため `scenarios/_map.yaml` の `wpf:` / `winforms:` の節での読み替えは要りません。

- WPF：`x:Name` を論理名にする。C# の識別子にできないもの（`new`、`-` を含むもの）は `AutomationProperties.AutomationId` で付ける
- WinForms：コントロールの `Name` を論理名にする（フィールド名は C# の識別子、`Name` の値だけ論理名）
- 画面：状態ID を名前に持つ `UserControl`（WPF はルートの `x:Name`、WinForms は `this.Name`）。表示中の画面だけがウィンドウに置かれます

| 画面（状態ID） | 論理名 | WPF（`Views/`） | WinForms（`Screens/`） |
|---|---|---|---|
| `List` 注文一覧 | `List` | `ListScreen.xaml` ルート `x:Name` | `ListScreen` `this.Name` |
| | `orders`（件数） | `DataGrid x:Name` | `DataGridView` `Name` |
| | `new` | `Button AutomationId` | `Button` `Name`（フィールド `newButton`） |
| `Input` 注文入力 | `Input` | `InputScreen.xaml` ルート `x:Name` | `InputScreen` `this.Name` |
| | `customer` | `TextBox x:Name` | `TextBox` `Name` |
| | `sku` | `ComboBox x:Name`（項目の表示は `A-100`・`B-200`） | `ListBox` `Name`（同左） |
| | `quantity` | `TextBox x:Name` | `TextBox` `Name` |
| | `error` | `TextBlock x:Name`（入力NG のときだけ表示） | `Label` `Name`（同左） |
| | `cancel`・`next` | `Button x:Name` | `Button` `Name` |
| `Confirm` 入力確認 | `Confirm` | `ConfirmScreen.xaml` ルート `x:Name` | `ConfirmScreen` `this.Name` |
| | `confirm-customer`・`confirm-sku`・`confirm-quantity` | `TextBlock AutomationId` | `Label` `Name` |
| | `submit-error` | `TextBlock AutomationId`（在庫不足のときだけ表示） | `Label` `Name`（同左） |
| | `back`・`submit` | `Button x:Name` | `Button` `Name` |
| `Done` 完了 | `Done` | `DoneScreen.xaml` ルート `x:Name` | `DoneScreen` `this.Name` |
| | `done-message` | `TextBlock AutomationId` | `Label` `Name` |
| | `to-list` | `Button AutomationId` | `Button` `Name` |

- WinForms の `sku` は `ComboBox` ではなく `ListBox` です。WinForms の `ComboBox`（ドロップダウン）は UI Automation で項目（SelectionItem）が見えず、表示文字列で選べないためです
