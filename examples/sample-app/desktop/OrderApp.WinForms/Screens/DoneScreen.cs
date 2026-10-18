using OrderApp.Core;

namespace OrderApp.WinForms.Screens;

/// <summary>画面 Done（完了）。</summary>
public partial class DoneScreen : UserControl, IOrderScreen
{
    public DoneScreen()
    {
        InitializeComponent();
        doneMessage.Text = OrderFlow.DoneMessage;
    }

    public event EventHandler<string>? EventRequested;

    public void Render(OrderFlow flow) { }

    public void Apply(OrderFlow flow) { }

    private void toList_Click(object? sender, EventArgs e) => EventRequested?.Invoke(this, ScreenEvents.ToList);
}
