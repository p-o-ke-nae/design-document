import { Component, type ReactNode } from 'react';

type Props = { resetKey: string; children: ReactNode };
type State = { error: Error | null; key: string };

/** Keeps the header when the body fails to render: shows the error and 「再読み込み」 instead of a white screen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="render-error" role="alert" data-testid="render-error">
        <h2>画面を表示できませんでした</h2>
        <pre className="render-error-message">{error.message}</pre>
        <button type="button" onClick={() => location.reload()} data-testid="render-error-reload">
          再読み込み
        </button>
      </div>
    );
  }
}
