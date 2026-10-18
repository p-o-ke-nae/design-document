namespace Ddv.FlaUiDriver;

/// <summary>見つけた結果。<c>Visible</c> は title のとき「前面のウィンドウか」。</summary>
public sealed record FindChoice<T>(bool Found, bool Visible, T? Item)
{
    public static FindChoice<T> NotFound { get; } = new(false, false, default);
}

/// <summary>
/// 要素の探し方（flaui-driver.md「要素の探し方」）。UI Automation に依存しない選び方だけを持つ（driver.Tests で確かめる）。
/// ウィンドウは前面のものから順に渡す。
/// </summary>
public static class ElementFinder
{
    /// <summary>by=title：アプリのトップレベルのウィンドウにそのタイトルがあるか。visible は前面（先頭）のウィンドウかどうか。</summary>
    public static FindChoice<TWindow> ByTitle<TWindow>(IReadOnlyList<TWindow> windowsFrontFirst, Func<TWindow, string?> title, string name)
    {
        for (var i = 0; i < windowsFrontFirst.Count; i++)
        {
            if (string.Equals(title(windowsFrontFirst[i])?.Trim(), name.Trim(), StringComparison.Ordinal))
                return new FindChoice<TWindow>(true, i == 0, windowsFrontFirst[i]);
        }
        return FindChoice<TWindow>.NotFound;
    }

    /// <summary>
    /// by=automationId：前面のウィンドウから順に、子孫のその AutomationId の要素を集め、IsOffscreen でない最初の要素を選ぶ。
    /// すべて IsOffscreen なら最初の要素（visible=false）。
    /// </summary>
    public static FindChoice<TElement> ByAutomationId<TWindow, TElement>(
        IReadOnlyList<TWindow> windowsFrontFirst,
        Func<TWindow, IEnumerable<TElement>> descendantsWithId,
        Func<TElement, bool> isOffscreen)
    {
        TElement? first = default;
        var any = false;
        foreach (var w in windowsFrontFirst)
        {
            foreach (var e in descendantsWithId(w))
            {
                if (!isOffscreen(e)) return new FindChoice<TElement>(true, true, e);
                if (!any)
                {
                    first = e;
                    any = true;
                }
            }
        }
        return any ? new FindChoice<TElement>(true, false, first) : FindChoice<TElement>.NotFound;
    }

    /// <summary>入力の方法（flaui-driver.md「操作の方法」）。Toggle → select → Value の順。どれもなければ null。</summary>
    public static string? FillMethod(IReadOnlyCollection<string> patterns)
    {
        if (patterns.Contains(Patterns.Toggle)) return "toggle";
        if (patterns.Contains(Patterns.Selection) || patterns.Contains(Patterns.ExpandCollapse)) return "select";
        if (patterns.Contains(Patterns.Value)) return "setValue";
        return null;
    }
}

/// <summary><c>find</c> の結果の <c>patterns</c> に入れる名前。</summary>
public static class Patterns
{
    public const string Toggle = "Toggle";
    /// <summary>要素が Selection を持つか、SelectionItem を持つ子がある。</summary>
    public const string Selection = "Selection";
    public const string ExpandCollapse = "ExpandCollapse";
    public const string Value = "Value";
    public const string Invoke = "Invoke";
    public const string Grid = "Grid";
}
