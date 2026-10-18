using System.Globalization;

namespace OrderApp.Core;

/// <summary>入力チェック（docs/design/basic/order.md#入力チェック）。</summary>
public static class OrderValidator
{
    public static IReadOnlyList<string> Validate(string customer, string sku, string quantity, out int parsedQuantity)
    {
        var errors = new List<string>();
        customer = customer.Trim();
        if (customer.Length is < 1 or > 50) errors.Add("顧客名は1〜50文字");
        if (string.IsNullOrWhiteSpace(sku)) errors.Add("商品を選択してください");
        if (!int.TryParse(quantity.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsedQuantity)
            || parsedQuantity is < 1 or > 99)
        {
            parsedQuantity = 0;
            errors.Add("数量は1〜99");
        }
        return errors;
    }
}

/// <summary>
/// 画面遷移の制御（docs/design/basic/order.md#画面遷移。Web の web/src/screenFlow.ts と同じ規則）。
/// WPF の ViewModel と WinForms のフォームが共通に使う。
/// </summary>
public sealed class OrderFlow(OrderStore store)
{
    public const string InputErrorMessage = "入力内容を確認してください";
    public const string DoneMessage = "注文を受け付けました";

    /// <summary>商品の選択肢（モックの select の option と同じ）。</summary>
    public static IReadOnlyList<string> Skus { get; } = ["A-100", "B-200"];

    public OrderStore Store { get; } = store;
    public Screen Screen { get; private set; } = Screen.List;

    public string Customer { get; set; } = "";
    public string Sku { get; set; } = "";
    public string Quantity { get; set; } = "1";

    public IReadOnlyList<string> Errors { get; private set; } = [];
    public string? SubmitError { get; private set; }
    public OrderDraft? Draft => Store.CurrentDraft;
    public IReadOnlyList<OrderRow> Orders => Store.ListOrders();

    /// <summary>画面・表示が変わった。</summary>
    public event EventHandler? Changed;

    /// <summary>イベントを送り、遷移先の画面を返す。今の画面で受け付けないイベントは InvalidOperationException。</summary>
    public Screen Send(string ev)
    {
        var next = (Screen, ev) switch
        {
            (Screen.List, ScreenEvents.New) => StartInput(),
            (Screen.Input, ScreenEvents.Next) => Next(),
            (Screen.Input, ScreenEvents.Cancel) => Screen.List,
            (Screen.Confirm, ScreenEvents.Back) => Screen.Input,
            (Screen.Confirm, ScreenEvents.Submit) => Submit(),
            (Screen.Done, ScreenEvents.ToList) => Screen.List,
            _ => throw new InvalidOperationException($"{Screen} では {ev} を受け付けません"),
        };
        if (next != Screen.Input) Errors = [];
        if (next != Screen.Confirm) SubmitError = null;
        Screen = next;
        Changed?.Invoke(this, EventArgs.Empty);
        return next;
    }

    private Screen StartInput()
    {
        Customer = "";
        Sku = "";
        Quantity = "1";
        Errors = [];
        return Screen.Input;
    }

    private Screen Next()
    {
        Errors = OrderValidator.Validate(Customer, Sku, Quantity, out var qty);
        if (Errors.Count > 0) return Screen.Input;
        Store.SaveDraft(new OrderDraft(Customer.Trim(), Sku, qty));
        return Screen.Confirm;
    }

    private Screen Submit()
    {
        var result = Store.Submit(Draft ?? throw new InvalidOperationException("下書きがありません"));
        SubmitError = result.Error;
        return result.Ok ? Screen.Done : Screen.Confirm;
    }
}
