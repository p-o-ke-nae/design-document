using System.Text.Json.Nodes;
using Ddv.FlaUiDriver;

namespace FlaUiDriver.Tests;

/// <summary>要素の探し方（flaui-driver.md「要素の探し方」の FIND の図）。ウィンドウは前面のものから順。</summary>
public class ElementFinderTests
{
    private sealed record Win(string Title, params El[] Elements);

    private sealed record El(string Id, bool Offscreen);

    private static readonly IReadOnlyList<Win> Windows =
    [
        new Win("確認", new El("ok", false)),
        new Win("注文受付", new El("customer", false), new El("hidden", true), new El("dup", true), new El("ok", false)),
        new Win("別", new El("dup", false), new El("hidden", true)),
    ];

    private static FindChoice<El> ById(string name) =>
        ElementFinder.ByAutomationId(Windows, w => w.Elements.Where(e => e.Id == name), e => e.Offscreen);

    [Fact]
    [Trait("TestId", "DD-FLAUI-FIND-P001")]
    [Trait("TestId", "DD-FLAUI-FIND-T001")]
    [Trait("TestId", "DD-FLAUI-FIND-T002")]
    [Trait("TestId", "DD-FLAUI-FIND-T003")]
    public void Title_found_reports_whether_front()
    {
        var front = ElementFinder.ByTitle(Windows, w => w.Title, "確認");
        Assert.True(front.Found);
        Assert.True(front.Visible);
        var back = ElementFinder.ByTitle(Windows, w => w.Title, " 注文受付 ");
        Assert.True(back.Found);
        Assert.False(back.Visible);
        Assert.Equal("注文受付", back.Item!.Title);
    }

    [Fact]
    [Trait("TestId", "DD-FLAUI-FIND-P002")]
    [Trait("TestId", "DD-FLAUI-FIND-T004")]
    public void Title_not_found()
    {
        var r = ElementFinder.ByTitle(Windows, w => w.Title, "無い");
        Assert.False(r.Found);
        Assert.False(r.Visible);
        Assert.Null(r.Item);
    }

    [Fact]
    [Trait("TestId", "DD-FLAUI-FIND-P003")]
    [Trait("TestId", "DD-FLAUI-FIND-T005")]
    [Trait("TestId", "DD-FLAUI-FIND-T006")]
    [Trait("TestId", "DD-FLAUI-FIND-T007")]
    public void AutomationId_not_in_any_window()
    {
        var r = ById("nothing");
        Assert.False(r.Found);
        Assert.Null(r.Item);
    }

    [Fact]
    [Trait("TestId", "DD-FLAUI-FIND-P004")]
    [Trait("TestId", "DD-FLAUI-FIND-T008")]
    [Trait("TestId", "DD-FLAUI-FIND-T009")]
    public void AutomationId_prefers_the_first_visible_element_from_the_front()
    {
        // 前面のウィンドウの ok を選ぶ
        var ok = ById("ok");
        Assert.True(ok.Found);
        Assert.True(ok.Visible);
        Assert.Same(Windows[0].Elements[0], ok.Item);
        // 見えていない dup より、後ろのウィンドウの見えている dup
        var dup = ById("dup");
        Assert.True(dup.Visible);
        Assert.Same(Windows[2].Elements[0], dup.Item);
    }

    [Fact]
    [Trait("TestId", "DD-FLAUI-FIND-P005")]
    [Trait("TestId", "DD-FLAUI-FIND-T010")]
    public void AutomationId_all_offscreen_returns_the_first_with_visible_false()
    {
        var r = ById("hidden");
        Assert.True(r.Found);
        Assert.False(r.Visible);
        Assert.Same(Windows[1].Elements[1], r.Item);
    }

    [Theory]
    [InlineData(new[] { "Toggle", "Value" }, "toggle")]
    [InlineData(new[] { "ExpandCollapse", "Value" }, "select")]
    [InlineData(new[] { "Selection" }, "select")]
    [InlineData(new[] { "Value", "Invoke" }, "setValue")]
    [InlineData(new[] { "Invoke" }, null)]
    public void Fill_method_by_patterns(string[] patterns, string? expected) => Assert.Equal(expected, ElementFinder.FillMethod(patterns));
}

/// <summary>通信の形式（1 行の要求 → 1 行の応答）。</summary>
public class ProtocolTests
{
    private sealed class Fake : ICommands
    {
        public JsonNode? Run(string cmd, JsonObject args) => cmd switch
        {
            "echo" => args.DeepClone(),
            "list" => new JsonObject { ["patterns"] = Patterns("Value", "Invoke") },
            "fail" => throw new DriverException("notFound", "要素が見つかりません: x"),
            _ => throw new InvalidOperationException("boom"),
        };
    }

    [Fact]
    public void Ok_response_keeps_the_id()
    {
        var r = JsonNode.Parse(Program.Handle(new Fake(), """{"id":7,"cmd":"echo","args":{"name":"顧客"}}"""))!;
        Assert.Equal(7, r["id"]!.GetValue<int>());
        Assert.True(r["ok"]!.GetValue<bool>());
        Assert.Equal("顧客", r["result"]!["name"]!.GetValue<string>());
    }

    private static JsonArray Patterns(params string[] names)
    {
        var a = new JsonArray();
        foreach (var n in names) a.Add(n);
        return a;
    }

    [Fact]
    public void Generic_values_are_written()
    {
        var r = JsonNode.Parse(Program.Handle(new Fake(), """{"id":"a","cmd":"list"}"""))!;
        Assert.Equal("Value,Invoke", string.Join(",", r["result"]!["patterns"]!.AsArray().Select(x => x!.GetValue<string>())));
        Assert.Equal("a", r["id"]!.GetValue<string>());
    }

    [Fact]
    public void Driver_error_has_the_code()
    {
        var r = JsonNode.Parse(Program.Handle(new Fake(), """{"id":1,"cmd":"fail"}"""))!;
        Assert.False(r["ok"]!.GetValue<bool>());
        Assert.Equal("notFound", r["error"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public void Unexpected_and_bad_requests_are_errors_not_crashes()
    {
        Assert.Equal("error", JsonNode.Parse(Program.Handle(new Fake(), """{"id":2,"cmd":"other"}"""))!["error"]!["code"]!.GetValue<string>());
        Assert.Equal("bad-request", JsonNode.Parse(Program.Handle(new Fake(), "not json"))!["error"]!["code"]!.GetValue<string>());
        Assert.Equal("bad-request", JsonNode.Parse(Program.Handle(new Fake(), """{"id":3}"""))!["error"]!["code"]!.GetValue<string>());
    }
}
