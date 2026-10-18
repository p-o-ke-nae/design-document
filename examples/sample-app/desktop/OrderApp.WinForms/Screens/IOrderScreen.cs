using OrderApp.Core;

namespace OrderApp.WinForms.Screens;

/// <summary>
/// 画面（UserControl）の共通の口。UserControl の Name が画面遷移図の状態ID。
/// 画面は UserControl を直接継承する（ddv の名前の検査が *.Designer.cs と同名の *.cs の基底で画面を見分けるため）。
/// </summary>
public interface IOrderScreen
{
    /// <summary>画面のボタンが押された（値はイベント名）。</summary>
    event EventHandler<string>? EventRequested;

    /// <summary>表示の前に、流れの状態を画面に反映する。</summary>
    void Render(OrderFlow flow);

    /// <summary>イベントを送る前に、画面の入力を流れに戻す。</summary>
    void Apply(OrderFlow flow);
}
