// Evidence hooks of a scenario session (detailed design evidence-runner.md#構造). Types only.
// These shapes belong to `@ddv/evidence` (EvidenceHost / HookHostContext / DesktopApp / TableDump); they are defined here
// until that package exists so that `ScenarioSession` can implement them. The evidence package should own them and
// `@ddv/mock` re-export them.
import type { Page } from '@playwright/test';
import type { Platform } from './platform.ts';
import type { Row, TraceTarget } from './trace-format.ts';

/** One table of the mock's pseudo DB (`window.__ddv.dump()`). */
export interface TableDump {
  name: string;
  key: string;
  rows: Row[];
}

/** Desktop app handle for hooks' evidence functions (implemented by `FlaUiSession`). */
export interface DesktopApp {
  find(key: string): Promise<{ found: boolean; visible: boolean }>;
  screenshot(path: string, key?: string): Promise<void>;
}

/** `ctx.page` (web) or `ctx.app` (desktop) of hooks' evidence functions; only one is set. */
export interface HookHostContext {
  page?: Page;
  app?: DesktopApp;
}

export interface ScreenshotOptions {
  /** Whole page (web only). */
  fullPage?: boolean;
}

/** What the evidence runner needs from the running session. */
export interface EvidenceHost {
  readonly platform: Platform;
  readonly target: TraceTarget;
  screenshot(path: string, opts?: ScreenshotOptions): Promise<void>;
  /** Screenshot of one element; throws when it is not found or off screen. */
  screenshotElement(key: string, path: string): Promise<void>;
  /** Pseudo DB tables of the mock, or null when the target is not a mock. */
  mockTables(): Promise<TableDump[] | null>;
  hookContext(): HookHostContext;
}
