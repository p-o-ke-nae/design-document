using OrderApp.Core;

namespace OrderApp.WinForms.Screens;

/// <summary>画面 Input（注文入力）。</summary>
public partial class InputScreen : UserControl, IOrderScreen
{
    public InputScreen()
    {
        InitializeComponent();
        sku.Items.AddRange([.. OrderFlow.Skus]);
        error.Text = OrderFlow.InputErrorMessage;
    }

    public event EventHandler<string>? EventRequested;

    public void Render(OrderFlow flow)
    {
        customer.Text = flow.Customer;
        sku.SelectedIndex = sku.Items.IndexOf(flow.Sku);
        quantity.Text = flow.Quantity;
        error.Visible = flow.Errors.Count > 0;
        errorTip.SetToolTip(error, string.Join(" / ", flow.Errors));
    }

    public void Apply(OrderFlow flow)
    {
        flow.Customer = customer.Text;
        flow.Sku = sku.SelectedItem as string ?? "";
        flow.Quantity = quantity.Text;
    }

    private void cancel_Click(object? sender, EventArgs e) => EventRequested?.Invoke(this, ScreenEvents.Cancel);

    private void next_Click(object? sender, EventArgs e) => EventRequested?.Invoke(this, ScreenEvents.Next);
}
