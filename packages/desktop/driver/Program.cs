using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Ddv.FlaUiDriver;

/// <summary>
/// 標準入力から 1 行ずつ要求 <c>{"id","cmd","args"}</c> を読み、標準出力に 1 行ずつ応答を書く（flaui-driver.md「通信の形式」）。
/// ログは標準エラー。待機・再試行・判定はしない（実行器が行う）。
/// </summary>
public static class Program
{
    public const string Version = "0.1.0";

    public static int Main()
    {
        var utf8 = new UTF8Encoding(false);
        using var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true };
        using var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
        using var commands = new Commands();
        stdout.WriteLine(new JsonObject { ["ready"] = true, ["version"] = Version }.ToJsonString());
        string? line;
        while ((line = stdin.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            stdout.WriteLine(Handle(commands, line));
        }
        return 0;
    }

    /// <summary>1 行の要求を処理して応答の JSON を返す。</summary>
    public static string Handle(ICommands commands, string line)
    {
        JsonNode? id = null;
        try
        {
            var req = JsonNode.Parse(line) as JsonObject ?? throw new DriverException("bad-request", "要求が JSON のオブジェクトではありません");
            id = req["id"]?.DeepClone();
            var cmd = req["cmd"]?.GetValue<string>() ?? throw new DriverException("bad-request", "cmd がありません");
            var args = req["args"] as JsonObject ?? new JsonObject();
            var result = commands.Run(cmd, args);
            return new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result }.ToJsonString(Json.Options);
        }
        catch (DriverException e)
        {
            return Error(id, e.Code, e.Message);
        }
        catch (JsonException e)
        {
            return Error(id, "bad-request", e.Message);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e);
            return Error(id, "error", e.Message);
        }
    }

    private static string Error(JsonNode? id, string code, string message) =>
        new JsonObject { ["id"] = id?.DeepClone(), ["ok"] = false, ["error"] = new JsonObject { ["code"] = code, ["message"] = message } }.ToJsonString(Json.Options);
}

internal static class Json
{
    /// <summary>日本語をエスケープせずに書く（ログで読めるように）。</summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        // JsonArray.Add<T> などで作られた値も書けるように
        TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver(),
    };
}

/// <summary>コマンドの実行（テストでは差し替える）。</summary>
public interface ICommands
{
    JsonNode? Run(string cmd, JsonObject args);
}

/// <summary>応答の <c>error.code</c> を持つ例外。</summary>
public sealed class DriverException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
