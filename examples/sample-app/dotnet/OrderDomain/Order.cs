namespace OrderDomain;

public enum OrderStatus
{
    Draft,
    Submitted,
    Approved,
    Rejected,
    Cancelled,
}

public sealed record OrderItem(string Sku, int Quantity);

/// <summary>注文（docs/design/detailed/order.md#状態）。</summary>
public sealed class Order
{
    public int Id { get; init; }
    public string Customer { get; init; } = "";
    public OrderStatus Status { get; private set; } = OrderStatus.Draft;
    public List<OrderItem> Items { get; } = new();

    public void Submit()
    {
        Require(OrderStatus.Draft, nameof(Submit));
        if (Items.Count == 0) throw new InvalidOperationException("明細がありません");
        Status = OrderStatus.Submitted;
    }

    public void Cancel()
    {
        Require(OrderStatus.Draft, nameof(Cancel));
        Status = OrderStatus.Cancelled;
    }

    public void Approve()
    {
        Require(OrderStatus.Submitted, nameof(Approve));
        Status = OrderStatus.Approved;
    }

    public void Reject()
    {
        Require(OrderStatus.Submitted, nameof(Reject));
        Status = OrderStatus.Rejected;
    }

    public void Revise()
    {
        Require(OrderStatus.Rejected, nameof(Revise));
        Status = OrderStatus.Draft;
    }

    private void Require(OrderStatus expected, string operation)
    {
        if (Status != expected)
            throw new InvalidOperationException($"{operation} は {Status} では実行できません");
    }
}
