namespace OrderApp.Core;

/// <summary>注文一覧の 1 行（モックの orders テーブルと同じ項目）。</summary>
public sealed record OrderRow(int Id, string Customer, string Sku, int Quantity, string Status);

/// <summary>入力中の注文（モックの drafts/current）。</summary>
public sealed record OrderDraft(string Customer, string Sku, int Quantity);

/// <summary>画面（画面遷移図の状態ID。docs/design/basic/order.md#画面遷移）。</summary>
public enum Screen
{
    List,
    Input,
    Confirm,
    Done,
}

/// <summary>画面遷移のイベント（図のイベント名。ガードを除く）。</summary>
public static class ScreenEvents
{
    public const string New = "新規";
    public const string Next = "次へ";
    public const string Cancel = "キャンセル";
    public const string Back = "戻る";
    public const string Submit = "確定";
    public const string ToList = "一覧へ";
}
