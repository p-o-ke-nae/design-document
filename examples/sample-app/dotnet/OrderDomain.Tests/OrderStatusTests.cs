using OrderDomain;

namespace OrderDomain.Tests;

public class OrderStatusTests
{
    private static Order NewOrder(bool withItem = true)
    {
        var o = new Order { Id = 1, Customer = "山田" };
        if (withItem) o.Items.Add(new OrderItem("A-100", 1));
        return o;
    }

    [Fact]
    [Trait("TestId", "DD-ORDER-STATUS-T001")]
    public void 新規作成するとDraft()
    {
        Assert.Equal(OrderStatus.Draft, NewOrder().Status);
    }

    [Fact]
    [Trait("TestId", "DD-ORDER-STATUS-T002")]
    public void 明細ありでSubmitするとSubmitted()
    {
        var o = NewOrder();
        o.Submit();
        Assert.Equal(OrderStatus.Submitted, o.Status);
    }

    [Fact]
    [Trait("TestId", "DD-ORDER-STATUS-T003")]
    public void CancelするとCancelled()
    {
        var o = NewOrder();
        o.Cancel();
        Assert.Equal(OrderStatus.Cancelled, o.Status);
    }

    [Fact]
    [Trait("TestId", "DD-ORDER-STATUS-T004")]
    public void ApproveするとApproved()
    {
        var o = NewOrder();
        o.Submit();
        o.Approve();
        Assert.Equal(OrderStatus.Approved, o.Status);
    }

    [Fact]
    [Trait("TestId", "DD-ORDER-STATUS-P002")]
    public void 却下から修正して再申請し承認される()
    {
        var o = NewOrder();
        o.Submit();
        o.Reject();
        o.Revise();
        o.Submit();
        o.Approve();
        Assert.Equal(OrderStatus.Approved, o.Status);
    }

    [Fact]
    [Trait("TestId", "DD-ORDER-STATUS-X001")]
    public void DraftでApproveは不正遷移()
    {
        Assert.Throws<InvalidOperationException>(() => NewOrder().Approve());
    }
}
