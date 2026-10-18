using OrderApp.Core;

namespace OrderApp.Desktop.Tests;

/// <summary>fixtures のファイル（docs/design/detailed/flaui-driver.md#fixtures-のファイル）の読み込み。</summary>
public sealed class FixtureDataTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "ddv-orderapp-tests-" + Guid.NewGuid().ToString("N"));

    public FixtureDataTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, true);

    private string Write(string json)
    {
        var path = Path.Combine(_dir, "fixtures.json");
        File.WriteAllText(path, json);
        return path;
    }

    private static Func<string, string?> Env(string? fixtures) =>
        name => name == FixtureData.FixturesEnv ? fixtures : null;

    [Fact]
    public void 指定が無ければ既定のデータ()
    {
        var data = FixtureData.Load([], Env(null));
        Assert.Same(FixtureData.Default, data);
        Assert.Equal(2, data.Orders.Count);
        Assert.Equal(10, data.Stock["A-100"]);
    }

    [Fact]
    public void 環境変数DDV_FIXTURESのJSONを読む()
    {
        var path = Write("""
            { "scenario": "BD-ORDER-SCREEN-P001", "fixtures": ["default", "more"],
              "tables": {
                "orders": [ { "id": 7, "customer": "山田 太郎", "sku": "A-100", "quantity": 2, "status": "Submitted" } ],
                "stock": [ { "sku": "A-100", "qty": 5 } ],
                "drafts": []
              } }
            """);
        var data = FixtureData.Load([], Env(path));
        Assert.Equal(path, data.Source);
        Assert.Equal("BD-ORDER-SCREEN-P001", data.Scenario);
        Assert.Equal(["default", "more"], data.FixtureNames);
        Assert.Equal([new OrderRow(7, "山田 太郎", "A-100", 2, "Submitted")], data.Orders);
        Assert.Equal(5, data.Stock["A-100"]);
    }

    [Fact]
    public void 引数のfixturesを環境変数より優先する()
    {
        var path = Write("""{ "tables": { "orders": [] } }""");
        Assert.Equal(path, FixtureData.ResolvePath(["--fixtures", path], Env("other.json")));
        Assert.Equal(path, FixtureData.ResolvePath([$"--fixtures={path}"], Env("other.json")));
        Assert.Equal("other.json", FixtureData.ResolvePath([], Env("other.json")));
    }

    [Fact]
    public void ファイルに無いテーブルは空_idが無ければ連番()
    {
        var data = FixtureData.Parse("""
            { "tables": { "orders": [ { "customer": "a", "sku": "A-100", "quantity": "3" }, { "customer": "b" } ] } }
            """);
        Assert.Equal([1, 2], data.Orders.Select(o => o.Id));
        Assert.Equal(3, data.Orders[0].Quantity);
        Assert.Empty(data.Stock);
    }

    [Fact]
    public void 在庫の行が無い商品は在庫不足()
    {
        var store = new OrderStore(FixtureData.Parse("""{ "tables": { "orders": [] } }"""));
        var result = store.Submit(new OrderDraft("山田", "A-100", 1));
        Assert.False(result.Ok);
        Assert.Equal(OrderStore.OutOfStockMessage, result.Error);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("{ not json")]
    public void 読めないファイルはFixtureException(string? content)
    {
        var path = content is null ? Path.Combine(_dir, "missing.json") : Write(content);
        var ex = Assert.Throws<FixtureException>(() => FixtureData.LoadFile(path));
        Assert.Contains(path, ex.Message);
    }
}
