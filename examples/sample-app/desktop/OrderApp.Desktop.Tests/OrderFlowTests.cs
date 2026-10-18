using OrderApp.Core;

namespace OrderApp.Desktop.Tests;

/// <summary>画面遷移（docs/design/basic/order.md#画面遷移）。Web の screenFlow.test.ts と同じテストID。</summary>
public class OrderFlowTests
{
    private static OrderFlow NewFlow() => new(new OrderStore(FixtureData.Default));

    private static OrderFlow AtInput(string customer = "山田 太郎", string sku = "A-100", string quantity = "1")
    {
        var f = NewFlow();
        f.Send(ScreenEvents.New);
        f.Customer = customer;
        f.Sku = sku;
        f.Quantity = quantity;
        return f;
    }

    [Fact]
    [Trait("TestId", "BD-ORDER-SCREEN-T001")]
    public void 開始すると一覧()
    {
        Assert.Equal(Screen.List, NewFlow().Screen);
    }

    [Fact]
    [Trait("TestId", "BD-ORDER-SCREEN-T002")]
    public void 一覧で新規を押すと入力へ()
    {
        Assert.Equal(Screen.Input, NewFlow().Send(ScreenEvents.New));
    }

    [Fact]
    [Trait("TestId", "BD-ORDER-SCREEN-T003")]
    public void 入力OKで次へを押すと確認へ_下書きを保存する()
    {
        var f = AtInput(customer: " 山田 太郎 ", quantity: "2");
        Assert.Equal(Screen.Confirm, f.Send(ScreenEvents.Next));
        Assert.Equal(new OrderDraft("山田 太郎", "A-100", 2), f.Draft);
    }

    [Theory]
    [Trait("TestId", "BD-ORDER-SCREEN-T004")]
    [InlineData("", "A-100", "1")]
    [InlineData("山田", "", "1")]
    [InlineData("山田", "A-100", "0")]
    [InlineData("山田", "A-100", "100")]
    [InlineData("山田", "A-100", "abc")]
    public void 入力NGで次へを押すと入力のまま(string customer, string sku, string quantity)
    {
        var f = AtInput(customer, sku, quantity);
        Assert.Equal(Screen.Input, f.Send(ScreenEvents.Next));
        Assert.NotEmpty(f.Errors);
        Assert.Null(f.Draft);
    }

    [Fact]
    public void 顧客名は50文字まで()
    {
        Assert.Equal(Screen.Confirm, AtInput(customer: new string('あ', 50)).Send(ScreenEvents.Next));
        Assert.Equal(Screen.Input, AtInput(customer: new string('あ', 51)).Send(ScreenEvents.Next));
    }

    [Fact]
    [Trait("TestId", "BD-ORDER-SCREEN-T005")]
    public void 入力でキャンセルすると一覧へ_エラーを消す()
    {
        var f = AtInput(customer: "");
        f.Send(ScreenEvents.Next);
        Assert.Equal(Screen.List, f.Send(ScreenEvents.Cancel));
        Assert.Empty(f.Errors);
    }

    [Fact]
    [Trait("TestId", "BD-ORDER-SCREEN-T006")]
    public void 確認で戻ると入力へ_入力を保持する()
    {
        var f = AtInput();
        f.Send(ScreenEvents.Next);
        Assert.Equal(Screen.Input, f.Send(ScreenEvents.Back));
        Assert.Equal("山田 太郎", f.Customer);
        Assert.Empty(f.Errors);
    }

    [Fact]
    [Trait("TestId", "BD-ORDER-SCREEN-T007")]
    public void 確定すると完了_注文がSubmittedで増える()
    {
        var f = AtInput(sku: "B-200", quantity: "3");
        f.Send(ScreenEvents.Next);
        Assert.Equal(Screen.Done, f.Send(ScreenEvents.Submit));
        Assert.Equal(new OrderRow(3, "山田 太郎", "B-200", 3, "Submitted"), f.Orders[^1]);
    }

    [Fact]
    public void 在庫不足なら確認に留まりメッセージを出す()
    {
        var f = AtInput(sku: "B-200", quantity: "4");
        f.Send(ScreenEvents.Next);
        Assert.Equal(Screen.Confirm, f.Send(ScreenEvents.Submit));
        Assert.Equal(OrderStore.OutOfStockMessage, f.SubmitError);
        Assert.Equal(2, f.Orders.Count);
        f.Send(ScreenEvents.Back);
        Assert.Null(f.SubmitError);
    }

    [Fact]
    [Trait("TestId", "BD-ORDER-SCREEN-T008")]
    public void 完了で一覧へを押すと一覧へ()
    {
        var f = AtInput();
        f.Send(ScreenEvents.Next);
        f.Send(ScreenEvents.Submit);
        Assert.Equal(Screen.List, f.Send(ScreenEvents.ToList));
        Assert.Equal(3, f.Orders.Count);
    }

    [Fact]
    [Trait("TestId", "BD-ORDER-SCREEN-P005")]
    public void キャンセルして入れ直し確定する()
    {
        var f = NewFlow();
        f.Send(ScreenEvents.New);
        Assert.Equal(Screen.List, f.Send(ScreenEvents.Cancel));
        Assert.Equal(2, f.Orders.Count);
        f.Send(ScreenEvents.New);
        f.Customer = "山田 太郎";
        f.Sku = "A-100";
        f.Send(ScreenEvents.Next);
        Assert.Equal(Screen.Done, f.Send(ScreenEvents.Submit));
    }

    [Theory]
    [Trait("TestId", "BD-ORDER-SCREEN-X004")]
    [InlineData(ScreenEvents.Next)]
    [InlineData(ScreenEvents.Cancel)]
    [InlineData(ScreenEvents.Back)]
    [InlineData(ScreenEvents.Submit)]
    [InlineData(ScreenEvents.ToList)]
    public void 一覧で受け付けないイベントは不正遷移(string ev)
    {
        Assert.Throws<InvalidOperationException>(() => NewFlow().Send(ev));
    }
}
