// Browser entry bundled into dist/mock-runtime.js. Mock pages load it with <script type="module">;
// mock.js uses `import { mock } from '../_ddv/mock-runtime.js'` (same module instance).
import { MockRuntime } from './runtime.ts';

declare global {
  interface Window {
    __ddv?: MockRuntime;
  }
}

const runtime: MockRuntime = window.__ddv ?? new MockRuntime();
window.__ddv = runtime;

export const mock = runtime;
export { MockRuntime };

const boot = () => {
  runtime.start().catch((e: unknown) => console.error('[ddv] モックの起動に失敗しました', e));
};
// Module scripts run before DOMContentLoaded, so mock.js registrations precede start.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else setTimeout(boot, 0);
