/**
 * The backend the screens call (services.md「ビルド時の選択」). `#backend-impl` is http.ts (local) or pages.ts (Pages) — vite.config.ts alias;
 * only one of them is in a bundle.
 */
import { createBackend } from '#backend-impl';
import type { Backend } from './types.ts';

export { createBackend };
export type { Backend } from './types.ts';

let currentScope = '';

/** The workspace the viewer shows ('' = local; Pages: the target key). `api` follows it. */
export function workspace(): string {
  return currentScope;
}

export function setWorkspace(scope: string): void {
  if (scope === currentScope) return;
  currentScope = scope;
  api = createBackend(scope);
}

export let api: Backend = createBackend('');
