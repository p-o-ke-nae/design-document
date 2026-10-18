using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Capturing;
using FlaUI.Core.Definitions;
using FlaUI.UIA2;
using FlaUI.UIA3;

namespace Ddv.FlaUiDriver;

/// <summary>
/// コマンドの実装（flaui-driver.md「通信の形式」）。状態として持つのは起動したアプリと Automation だけ。
/// </summary>
public sealed class Commands : ICommands, IDisposable
{
    private Application? app;
    private AutomationBase? automation;

    public JsonNode? Run(string cmd, JsonObject args) => cmd switch
    {
        "launch" => Launch(args),
        "find" => Find(args),
        "setValue" => SetValue(args),
        "select" => Select(args),
        "toggle" => Toggle(args),
        "invoke" => Invoke(args),
        "query" => Query(args),
        "screenshot" => Screenshot(args),
        "close" => Close(args),
        _ => throw new DriverException("unknown-command", $"不明なコマンドです: {cmd}"),
    };

    private static string Str(JsonObject args, string name) =>
        args[name]?.GetValue<string>() ?? throw new DriverException("bad-request", $"{name} がありません");

    private static string? OptStr(JsonObject args, string name) => args[name]?.GetValue<string>();

    private static int Int(JsonObject args, string name, int fallback) => args[name] is JsonValue v && v.TryGetValue<int>(out var n) ? n : fallback;

    private Application App => app ?? throw new DriverException("no-window", "アプリが起動していません");
    private AutomationBase Automation => automation ?? throw new DriverException("no-window", "アプリが起動していません");

    private JsonNode Launch(JsonObject args)
    {
        CloseApp(5000);
        var path = Str(args, "path");
        var psi = new ProcessStartInfo(path)
        {
            UseShellExecute = false,
            WorkingDirectory = OptStr(args, "cwd") ?? Path.GetDirectoryName(Path.GetFullPath(path)) ?? Environment.CurrentDirectory,
        };
        if (args["args"] is JsonArray list) foreach (var a in list) psi.ArgumentList.Add(a?.GetValue<string>() ?? "");
        if (args["env"] is JsonObject env) foreach (var (k, v) in env) psi.Environment[k] = v?.GetValue<string>();
        automation = OptStr(args, "automation") == "uia2" ? new UIA2Automation() : new UIA3Automation();
        try
        {
            app = Application.Launch(psi);
        }
        catch (Exception e)
        {
            throw new DriverException("launch-failed", $"アプリを起動できません: {path}（{e.Message}）");
        }
        var timeout = TimeSpan.FromMilliseconds(Int(args, "timeoutMs", 30000));
        Window? main;
        try
        {
            main = app.GetMainWindow(automation, timeout);
        }
        catch (Exception e)
        {
            main = null;
            Console.Error.WriteLine(e);
        }
        if (main is null)
        {
            var exited = app.HasExited;
            var code = exited ? ExitCodeOf(app) : null;
            throw new DriverException("no-window", exited
                ? $"アプリが終了しました（終了コード {code?.ToString() ?? "不明"}）"
                : $"アプリのウィンドウが {timeout.TotalMilliseconds} ms で表示されません");
        }
        return new JsonObject { ["pid"] = app.ProcessId, ["title"] = main.Properties.Name.ValueOrDefault, ["automationId"] = main.Properties.AutomationId.ValueOrDefault };
    }

    /// <summary>終了コード。分からなければ null（Application が起動したプロセスで取れないときもある）。</summary>
    private static int? ExitCodeOf(Application a)
    {
        try
        {
            return a.ExitCode;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>アプリのトップレベルのウィンドウ（モーダルのダイアログを含む）を前面のものから順に。</summary>
    private List<Window> WindowsFrontFirst()
    {
        var windows = App.GetAllTopLevelWindows(Automation);
        var order = ZOrder();
        return windows
            .Select(w => (w, z: order.TryGetValue(w.Properties.NativeWindowHandle.ValueOrDefault, out var i) ? i : int.MaxValue))
            .OrderBy(x => x.z)
            .Select(x => x.w)
            .ToList();
    }

    private static Dictionary<IntPtr, int> ZOrder()
    {
        var map = new Dictionary<IntPtr, int>();
        var i = 0;
        EnumWindows((h, _) =>
        {
            map[h] = i++;
            return true;
        }, IntPtr.Zero);
        return map;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    private static bool Offscreen(AutomationElement e)
    {
        try
        {
            return e.Properties.IsOffscreen.ValueOrDefault;
        }
        catch
        {
            return true;
        }
    }

    private FindChoice<AutomationElement> FindElement(string by, string name)
    {
        var windows = WindowsFrontFirst();
        if (by == "title")
        {
            var w = ElementFinder.ByTitle(windows, x => x.Properties.Name.ValueOrDefault ?? "", name);
            return new FindChoice<AutomationElement>(w.Found, w.Visible, w.Item);
        }
        return ElementFinder.ByAutomationId(windows, w => w.FindAllDescendants(cf => cf.ByAutomationId(name)), Offscreen);
    }

    private AutomationElement Require(JsonObject args)
    {
        var name = Str(args, "name");
        var f = FindElement(OptStr(args, "by") ?? "automationId", name);
        return f.Found && f.Item is not null ? f.Item : throw new DriverException("notFound", $"要素が見つかりません: {name}");
    }

    private static List<string> PatternsOf(AutomationElement e)
    {
        var p = new List<string>();
        if (e.Patterns.Toggle.IsSupported) p.Add(Patterns.Toggle);
        if (e.Patterns.Selection.IsSupported || HasSelectionItemChild(e)) p.Add(Patterns.Selection);
        if (e.Patterns.ExpandCollapse.IsSupported) p.Add(Patterns.ExpandCollapse);
        if (e.Patterns.Value.IsSupported) p.Add(Patterns.Value);
        if (e.Patterns.Invoke.IsSupported) p.Add(Patterns.Invoke);
        if (e.Patterns.Grid.IsSupported) p.Add(Patterns.Grid);
        return p;
    }

    private static bool HasSelectionItemChild(AutomationElement e)
    {
        try
        {
            return e.FindAllChildren().Any(c => c.Patterns.SelectionItem.IsSupported);
        }
        catch
        {
            return false;
        }
    }

    private JsonNode Find(JsonObject args)
    {
        var f = FindElement(OptStr(args, "by") ?? "automationId", Str(args, "name"));
        if (!f.Found || f.Item is null) return new JsonObject { ["found"] = false, ["visible"] = false, ["controlType"] = null, ["patterns"] = new JsonArray() };
        var patterns = new JsonArray();
        foreach (var p in PatternsOf(f.Item)) patterns.Add(JsonValue.Create(p));
        return new JsonObject { ["found"] = true, ["visible"] = f.Visible, ["controlType"] = f.Item.ControlType.ToString(), ["patterns"] = patterns };
    }

    private JsonNode SetValue(JsonObject args)
    {
        var e = Require(args);
        if (!e.Patterns.Value.IsSupported) throw new DriverException("no-pattern", "値を入力できない要素です");
        var value = e.Patterns.Value.Pattern;
        if (value.IsReadOnly.ValueOrDefault) throw new DriverException("readonly", "読み取り専用の要素です");
        value.SetValue(Str(args, "value"));
        return new JsonObject();
    }

    private JsonNode Select(JsonObject args)
    {
        var e = Require(args);
        var text = Str(args, "text").Trim();
        var expand = e.Patterns.ExpandCollapse.IsSupported ? e.Patterns.ExpandCollapse.Pattern : null;
        if (expand is null && !e.Patterns.Selection.IsSupported && !HasSelectionItemChild(e))
            throw new DriverException("no-pattern", "選択できない要素です");
        try
        {
            expand?.Expand();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
        }
        try
        {
            var item = e.FindAllDescendants()
                .FirstOrDefault(c => c.Patterns.SelectionItem.IsSupported && string.Equals(c.Properties.Name.ValueOrDefault?.Trim(), text, StringComparison.Ordinal));
            if (item is null) throw new DriverException("no-option", $"選択肢 {text} がありません");
            item.Patterns.SelectionItem.Pattern.Select();
        }
        finally
        {
            try
            {
                if (expand is not null && expand.ExpandCollapseState.ValueOrDefault != ExpandCollapseState.Collapsed) expand.Collapse();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
            }
        }
        return new JsonObject();
    }

    private JsonNode Toggle(JsonObject args)
    {
        var e = Require(args);
        if (!e.Patterns.Toggle.IsSupported) throw new DriverException("no-pattern", "オン・オフを切り替えられない要素です");
        var on = args["on"]?.GetValue<bool>() ?? true;
        var t = e.Patterns.Toggle.Pattern;
        for (var i = 0; i < 3 && (t.ToggleState.ValueOrDefault == ToggleState.On) != on; i++) t.Toggle();
        return new JsonObject();
    }

    private JsonNode Invoke(JsonObject args)
    {
        var e = Require(args);
        if (!e.IsEnabled) throw new DriverException("disabled", $"要素が無効です: {Str(args, "name")}");
        if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke();
        else e.Click();
        return new JsonObject();
    }

    private JsonNode? Query(JsonObject args)
    {
        var what = Str(args, "what");
        switch (what)
        {
            case "window":
            {
                var w = WindowsFrontFirst().FirstOrDefault();
                return w is null ? null : new JsonObject { ["title"] = w.Properties.Name.ValueOrDefault, ["automationId"] = w.Properties.AutomationId.ValueOrDefault };
            }
            case "visible":
            {
                var f = FindElement(OptStr(args, "by") ?? "automationId", Str(args, "name"));
                return JsonValue.Create(f.Found && f.Visible);
            }
            case "text":
            {
                var e = Require(args);
                if (e.Patterns.Value.IsSupported) return JsonValue.Create(e.Patterns.Value.Pattern.Value.ValueOrDefault ?? "");
                return JsonValue.Create(e.Properties.Name.ValueOrDefault ?? "");
            }
            case "count":
            {
                var e = Require(args);
                if (e.Patterns.Grid.IsSupported) return JsonValue.Create(e.Patterns.Grid.Pattern.RowCount.ValueOrDefault);
                return JsonValue.Create(e.FindAllChildren().Count(c => c.ControlType is ControlType.ListItem or ControlType.DataItem));
            }
            default:
                throw new DriverException("bad-request", $"不明な query です: {what}");
        }
    }

    private JsonNode Screenshot(JsonObject args)
    {
        var path = Str(args, "path");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        CaptureImage image;
        if (OptStr(args, "name") is { } name)
        {
            var f = FindElement(OptStr(args, "by") ?? "automationId", name);
            if (!f.Found || f.Item is null) throw new DriverException("notFound", $"要素が見つかりません: {name}");
            Rectangle rect;
            try
            {
                rect = f.Item.BoundingRectangle;
            }
            catch
            {
                rect = Rectangle.Empty;
            }
            if (!f.Visible || rect.Width <= 0 || rect.Height <= 0) throw new DriverException("offscreen", $"要素が画面に表示されていません: {name}");
            image = Capture.Rectangle(rect);
        }
        else
        {
            var w = WindowsFrontFirst().FirstOrDefault() ?? throw new DriverException("no-window", "ウィンドウがありません");
            image = Capture.Element(w);
        }
        using (image)
        {
            image.ToFile(path);
            return new JsonObject { ["width"] = image.Bitmap.Width, ["height"] = image.Bitmap.Height };
        }
    }

    private JsonNode Close(JsonObject args) => CloseApp(Int(args, "timeoutMs", 5000));

    private JsonObject CloseApp(int timeoutMs)
    {
        if (app is null) return new JsonObject { ["exitCode"] = null, ["killed"] = false };
        var killed = false;
        int? exitCode = null;
        try
        {
            using var p = Process.GetProcessById(app.ProcessId);
            if (!p.HasExited)
            {
                try
                {
                    app.Close();
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine(e.Message);
                }
                if (!p.WaitForExit(timeoutMs))
                {
                    p.Kill(true);
                    p.WaitForExit(timeoutMs);
                    killed = true;
                }
            }
            exitCode = p.HasExited ? ExitCodeOf(app) : null;
        }
        catch (ArgumentException)
        {
            // already exited
            exitCode = ExitCodeOf(app);
        }
        app.Dispose();
        app = null;
        automation?.Dispose();
        automation = null;
        return new JsonObject { ["exitCode"] = exitCode, ["killed"] = killed };
    }

    public void Dispose() => CloseApp(5000);
}
