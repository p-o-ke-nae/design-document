using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;
using OrderApp.Core;

namespace OrderApp.Wpf.ViewModels;

/// <summary>画面全体の ViewModel。画面遷移と入力チェックは <see cref="OrderFlow"/> に任せる。</summary>
public sealed class MainViewModel : INotifyPropertyChanged
{
    private readonly OrderFlow _flow;

    public MainViewModel(OrderFlow flow)
    {
        _flow = flow;
        NewCommand = Command(ScreenEvents.New);
        NextCommand = Command(ScreenEvents.Next);
        CancelCommand = Command(ScreenEvents.Cancel);
        BackCommand = Command(ScreenEvents.Back);
        SubmitCommand = Command(ScreenEvents.Submit);
        ToListCommand = Command(ScreenEvents.ToList);
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    public Screen Screen => _flow.Screen;

    public IReadOnlyList<OrderRow> Orders => _flow.Orders;
    public IReadOnlyList<string> Skus => OrderFlow.Skus;

    public string Customer
    {
        get => _flow.Customer;
        set => Set(_flow.Customer, value, v => _flow.Customer = v);
    }

    /// <summary>未選択は null（ComboBox の SelectedItem）。</summary>
    public string? Sku
    {
        get => _flow.Sku.Length == 0 ? null : _flow.Sku;
        set => Set(_flow.Sku, value ?? "", v => _flow.Sku = v);
    }

    public string Quantity
    {
        get => _flow.Quantity;
        set => Set(_flow.Quantity, value, v => _flow.Quantity = v);
    }

    public bool HasInputError => _flow.Errors.Count > 0;
    public string InputErrorMessage => OrderFlow.InputErrorMessage;
    public string InputErrorDetail => string.Join(" / ", _flow.Errors);

    public string ConfirmCustomer => _flow.Draft?.Customer ?? "";
    public string ConfirmSku => _flow.Draft?.Sku ?? "";
    public string ConfirmQuantity => _flow.Draft?.Quantity.ToString() ?? "";

    public bool HasSubmitError => _flow.SubmitError is not null;
    public string SubmitError => _flow.SubmitError ?? "";

    public string DoneMessage => OrderFlow.DoneMessage;

    public ICommand NewCommand { get; }
    public ICommand NextCommand { get; }
    public ICommand CancelCommand { get; }
    public ICommand BackCommand { get; }
    public ICommand SubmitCommand { get; }
    public ICommand ToListCommand { get; }

    private ICommand Command(string ev) => new RelayCommand(() =>
    {
        _flow.Send(ev);
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(string.Empty));
    });

    private void Set(string current, string value, Action<string> assign, [CallerMemberName] string? name = null)
    {
        if (current == value) return;
        assign(value);
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }
}

public sealed class RelayCommand(Action execute) : ICommand
{
    public event EventHandler? CanExecuteChanged { add { } remove { } }
    public bool CanExecute(object? parameter) => true;
    public void Execute(object? parameter) => execute();
}
