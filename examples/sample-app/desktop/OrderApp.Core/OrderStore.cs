using OrderDomain;

namespace OrderApp.Core;

/// <summary>確定の結果。失敗のときは画面に出すメッセージを持つ。</summary>
public sealed record SubmitResult(OrderRow? Order, string? Error)
{
    public bool Ok => Order is not null;
}

/// <summary>
/// 注文のデータ（モックの疑似 API docs/mocks/order/api.yaml と同じ振る舞い）。
/// orders・stock・drafts（current の 1 件）をメモリに持つ。
/// </summary>
public sealed class OrderStore
{
    public const string OutOfStockMessage = "在庫が不足しています";

    private readonly List<OrderRow> _orders;
    private readonly Dictionary<string, int> _stock;

    public OrderStore(FixtureData data)
    {
        _orders = [.. data.Orders];
        _stock = new Dictionary<string, int>(data.Stock);
    }

    public OrderDraft? CurrentDraft { get; private set; }

    /// <summary>GET /orders</summary>
    public IReadOnlyList<OrderRow> ListOrders() => _orders.ToList();

    /// <summary>POST /drafts（キー current で上書き保存）</summary>
    public void SaveDraft(OrderDraft draft) => CurrentDraft = draft;

    /// <summary>
    /// POST /orders。在庫（stock[sku].qty）が数量より少なければ 409 相当で失敗する。
    /// stock に無い商品は在庫 0 とみなす。状態は注文ドメインの Submit で決める。
    /// </summary>
    public SubmitResult Submit(OrderDraft draft)
    {
        var qty = _stock.TryGetValue(draft.Sku, out var q) ? q : 0;
        if (qty < draft.Quantity) return new SubmitResult(null, OutOfStockMessage);

        var order = new Order { Id = _orders.Count == 0 ? 1 : _orders.Max(o => o.Id) + 1, Customer = draft.Customer };
        order.Items.Add(new OrderItem(draft.Sku, draft.Quantity));
        order.Submit();

        var row = new OrderRow(order.Id, order.Customer, draft.Sku, draft.Quantity, order.Status.ToString());
        _orders.Add(row);
        return new SubmitResult(row, null);
    }
}
