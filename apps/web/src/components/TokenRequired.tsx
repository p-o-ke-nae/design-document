/** Shown without calling the API when the session cookie is missing or no longer valid (LOCALF). */
export function TokenRequired() {
  return (
    <div className="app">
      <div className="token-required" data-testid="token-required">
        <h2>ddv serve が表示した URL から開いてください</h2>
        <p className="muted">サーバを起動し直したときは、新しく表示された URL を開いてください</p>
      </div>
    </div>
  );
}
