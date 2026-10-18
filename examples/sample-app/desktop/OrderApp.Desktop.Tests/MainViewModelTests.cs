using System.ComponentModel;
using OrderApp.Core;
using OrderApp.Wpf.ViewModels;

namespace OrderApp.Desktop.Tests;

/// <summary>WPF の ViewModel（画面の表示に使う値とコマンド）。</summary>
public class MainViewModelTests
{
    private static MainViewModel NewViewModel() => new(new OrderFlow(new OrderStore(FixtureData.Default)));

    [Fact]
    public void 入力から確認へ進むと確認の表示が下書きになる()
    {
        var vm = NewViewModel();
        vm.NewCommand.Execute(null);
        vm.Customer = "山田 太郎";
        vm.Sku = "B-200";
        vm.Quantity = "2";
        vm.NextCommand.Execute(null);

        Assert.Equal(Screen.Confirm, vm.Screen);
        Assert.Equal(("山田 太郎", "B-200", "2"), (vm.ConfirmCustomer, vm.ConfirmSku, vm.ConfirmQuantity));
    }

    [Fact]
    public void 入力NGならエラーを表示して入力に留まる()
    {
        var vm = NewViewModel();
        vm.NewCommand.Execute(null);
        Assert.False(vm.HasInputError);
        Assert.Null(vm.Sku);

        vm.NextCommand.Execute(null);

        Assert.Equal(Screen.Input, vm.Screen);
        Assert.True(vm.HasInputError);
        Assert.Equal("入力内容を確認してください", vm.InputErrorMessage);
    }

    [Fact]
    public void コマンドの後はすべての表示を更新する()
    {
        var vm = NewViewModel();
        var changed = new List<string?>();
        ((INotifyPropertyChanged)vm).PropertyChanged += (_, e) => changed.Add(e.PropertyName);

        vm.NewCommand.Execute(null);
        vm.Customer = "a";
        vm.Customer = "a";

        Assert.Equal([string.Empty, nameof(MainViewModel.Customer)], changed);
    }

    [Fact]
    public void 確定から一覧へ戻ると件数が増えている()
    {
        var vm = NewViewModel();
        vm.NewCommand.Execute(null);
        vm.Customer = "山田 太郎";
        vm.Sku = "A-100";
        vm.NextCommand.Execute(null);
        vm.SubmitCommand.Execute(null);
        Assert.Equal("注文を受け付けました", vm.DoneMessage);
        vm.ToListCommand.Execute(null);

        Assert.Equal(Screen.List, vm.Screen);
        Assert.Equal(3, vm.Orders.Count);
    }
}
