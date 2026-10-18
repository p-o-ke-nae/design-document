using OrderApp.Core;

namespace OrderApp.WinForms.Screens;

/// <summary>画面 Confirm（入力確認）。名前に - を含むものはフィールド名だけ変え、Name を論理名にする。</summary>
public partial class ConfirmScreen : UserControl, IOrderScreen
{
    public ConfirmScreen() => InitializeComponent();

    public event EventHandler<string>? EventRequested;

    public void Render(OrderFlow flow)
    {
        confirmCustomer.Text = flow.Draft?.Customer ?? "";
        confirmSku.Text = flow.Draft?.Sku ?? "";
        confirmQuantity.Text = flow.Draft?.Quantity.ToString() ?? "";
        submitError.Text = flow.SubmitError ?? "";
        submitError.Visible = flow.SubmitError is not null;
    }

    public void Apply(OrderFlow flow) { }

    private void back_Click(object? sender, EventArgs e) => EventRequested?.Invoke(this, ScreenEvents.Back);

    private void submit_Click(object? sender, EventArgs e) => EventRequested?.Invoke(this, ScreenEvents.Submit);
}
