using OrderApp.Core;

namespace OrderApp.WinForms.Screens;

/// <summary>画面 List（注文一覧）。</summary>
public partial class ListScreen : UserControl, IOrderScreen
{
    public ListScreen()
    {
        InitializeComponent();
        orders.AutoGenerateColumns = false;
    }

    public event EventHandler<string>? EventRequested;

    public void Render(OrderFlow flow) => orders.DataSource = flow.Orders.ToList();

    public void Apply(OrderFlow flow) { }

    private void newButton_Click(object? sender, EventArgs e) => EventRequested?.Invoke(this, ScreenEvents.New);
}
