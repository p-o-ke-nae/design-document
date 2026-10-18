using OrderApp.Core;

namespace OrderApp.WinForms;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        FixtureData data;
        try
        {
            data = FixtureData.Load(args, Environment.GetEnvironmentVariable);
        }
        catch (FixtureException ex)
        {
            // ddv の実行ではウィンドウが出ないことで失敗が分かる。手で起動したときのためにメッセージも出す
            Console.Error.WriteLine(ex.Message);
            if (Environment.GetEnvironmentVariable(FixtureData.ScenarioEnv) is null)
                MessageBox.Show(ex.Message, "注文受付", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }
        Application.Run(new MainForm(new OrderFlow(new OrderStore(data))));
        return 0;
    }
}
