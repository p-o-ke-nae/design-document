using System.Globalization;
using System.Text.Json;

namespace OrderApp.Core;

/// <summary>
/// アプリの初期データ。ddv のデスクトップの実行では、環境変数 DDV_FIXTURES が指す JSON
/// （docs/design/detailed/flaui-driver.md#fixtures-のファイル）から読む。
/// </summary>
public sealed record FixtureData
{
    public const string FixturesEnv = "DDV_FIXTURES";
    public const string ScenarioEnv = "DDV_SCENARIO";
    public const string FixturesArg = "--fixtures";

    public IReadOnlyList<OrderRow> Orders { get; init; } = [];
    public IReadOnlyDictionary<string, int> Stock { get; init; } = new Dictionary<string, int>();
    /// <summary>読んだ fixtures のファイルのパス（既定のデータなら null）。</summary>
    public string? Source { get; init; }
    public string? Scenario { get; init; }
    public IReadOnlyList<string> FixtureNames { get; init; } = [];

    /// <summary>docs/mocks/order/fixtures/default.yaml と同じ内容。</summary>
    public static FixtureData Default { get; } = new()
    {
        Orders =
        [
            new OrderRow(1, "佐藤 花子", "A-100", 2, "Submitted"),
            new OrderRow(2, "鈴木 一郎", "B-200", 1, "Submitted"),
        ],
        Stock = new Dictionary<string, int> { ["A-100"] = 10, ["B-200"] = 3 },
        FixtureNames = ["default"],
    };

    /// <summary>
    /// fixtures のファイルのパスを決める。引数 <c>--fixtures &lt;path&gt;</c>（手で起動するとき用）を優先し、
    /// 無ければ環境変数 DDV_FIXTURES。どちらも無ければ null（既定のデータを使う）。
    /// </summary>
    public static string? ResolvePath(IReadOnlyList<string> args, Func<string, string?> getEnv)
    {
        for (var i = 0; i < args.Count; i++)
        {
            if (args[i] == FixturesArg && i + 1 < args.Count) return args[i + 1];
            if (args[i].StartsWith(FixturesArg + "=", StringComparison.Ordinal)) return args[i][(FixturesArg.Length + 1)..];
        }
        var env = getEnv(FixturesEnv);
        return string.IsNullOrWhiteSpace(env) ? null : env;
    }

    /// <summary>パスがあればそのファイルを、無ければ既定のデータを返す。</summary>
    public static FixtureData Load(IReadOnlyList<string> args, Func<string, string?> getEnv)
    {
        var path = ResolvePath(args, getEnv);
        return path is null ? Default : LoadFile(path);
    }

    /// <summary>ファイルを読む。読めない・形式が違うときは <see cref="FixtureException"/>。</summary>
    public static FixtureData LoadFile(string path)
    {
        string json;
        try
        {
            json = File.ReadAllText(path);
        }
        catch (Exception e)
        {
            throw new FixtureException($"fixtures のファイルが読めません: {path}（{e.Message}）", e);
        }
        try
        {
            return Parse(json) with { Source = path };
        }
        catch (Exception e) when (e is JsonException or FormatException or InvalidOperationException or KeyNotFoundException)
        {
            throw new FixtureException($"fixtures のファイルの形式が違います: {path}（{e.Message}）", e);
        }
    }

    /// <summary>
    /// <c>{ "scenario": "…", "fixtures": [ … ], "tables": { "orders": [ … ], "stock": [ … ] } }</c> を読む。
    /// モックと同じく、ファイルに無いテーブルは空とみなす。
    /// </summary>
    public static FixtureData Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var orders = new List<OrderRow>();
        var stock = new Dictionary<string, int>();
        if (root.TryGetProperty("tables", out var tables) && tables.ValueKind == JsonValueKind.Object)
        {
            if (tables.TryGetProperty("orders", out var rows))
            {
                var nextId = 1;
                foreach (var row in rows.EnumerateArray())
                {
                    var id = row.TryGetProperty("id", out var idEl) ? Int(idEl) : nextId;
                    nextId = Math.Max(nextId, id + 1);
                    orders.Add(new OrderRow(
                        id,
                        Str(row, "customer"),
                        Str(row, "sku"),
                        row.TryGetProperty("quantity", out var q) ? Int(q) : 0,
                        Str(row, "status")));
                }
            }
            if (tables.TryGetProperty("stock", out var stockRows))
            {
                foreach (var row in stockRows.EnumerateArray())
                    stock[Str(row, "sku")] = row.TryGetProperty("qty", out var q) ? Int(q) : 0;
            }
        }
        return new FixtureData
        {
            Orders = orders,
            Stock = stock,
            Scenario = root.TryGetProperty("scenario", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null,
            FixtureNames = root.TryGetProperty("fixtures", out var f) && f.ValueKind == JsonValueKind.Array
                ? f.EnumerateArray().Select(x => x.ToString()).ToList()
                : [],
        };
    }

    private static string Str(JsonElement row, string name) =>
        row.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? v.ToString() : "";

    private static int Int(JsonElement v) => v.ValueKind == JsonValueKind.Number
        ? v.GetInt32()
        : int.Parse(v.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture);
}

public sealed class FixtureException(string message, Exception inner) : Exception(message, inner);
