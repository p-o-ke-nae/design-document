using System.Windows;
using OrderApp.Core;
using OrderApp.Wpf.ViewModels;

namespace OrderApp.Wpf;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        FixtureData data;
        try
        {
            data = FixtureData.Load(e.Args, Environment.GetEnvironmentVariable);
        }
        catch (FixtureException ex)
        {
            // ddv の実行ではウィンドウが出ないことで失敗が分かる。手で起動したときのためにメッセージも出す
            Console.Error.WriteLine(ex.Message);
            if (Environment.GetEnvironmentVariable(FixtureData.ScenarioEnv) is null)
                MessageBox.Show(ex.Message, "注文受付", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(2);
            return;
        }
        var window = new MainWindow { DataContext = new MainViewModel(new OrderFlow(new OrderStore(data))) };
        MainWindow = window;
        window.Show();
    }
}
