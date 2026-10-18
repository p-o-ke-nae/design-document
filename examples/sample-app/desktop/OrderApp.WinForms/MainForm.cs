using OrderApp.Core;
using OrderApp.WinForms.Screens;
using Screen = OrderApp.Core.Screen;

namespace OrderApp.WinForms;

/// <summary>画面を 1 つだけ表示する枠。画面遷移は <see cref="OrderFlow"/> に任せる。</summary>
public partial class MainForm : Form
{
    private readonly OrderFlow _flow;
    private readonly Dictionary<Screen, UserControl> _screens;

    public MainForm(OrderFlow flow)
    {
        InitializeComponent();
        _flow = flow;
        _screens = new Dictionary<Screen, UserControl>
        {
            [Screen.List] = new ListScreen(),
            [Screen.Input] = new InputScreen(),
            [Screen.Confirm] = new ConfirmScreen(),
            [Screen.Done] = new DoneScreen(),
        };
        foreach (var screen in _screens.Values)
        {
            screen.Dock = DockStyle.Fill;
            ((IOrderScreen)screen).EventRequested += (_, ev) => Send(ev);
        }
        ShowScreen();
    }

    private void Send(string ev)
    {
        ((IOrderScreen)_screens[_flow.Screen]).Apply(_flow);
        _flow.Send(ev);
        ShowScreen();
    }

    /// <summary>表示中の画面だけをフォームに置く（ほかの画面の要素を UI Automation に見せない）。</summary>
    private void ShowScreen()
    {
        var screen = _screens[_flow.Screen];
        ((IOrderScreen)screen).Render(_flow);
        if (screenHost.Controls.Count == 1 && screenHost.Controls[0] == screen) return;
        screenHost.SuspendLayout();
        screenHost.Controls.Clear();
        screenHost.Controls.Add(screen);
        screenHost.ResumeLayout();
        screen.SelectNextControl(screen, true, true, true, false);
    }
}
