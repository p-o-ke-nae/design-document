import { readFileSync } from 'node:fs';

/** Version of @ddv/mock; written into `_ddv/mock-runtime.js` as its first line. */
export const MOCK_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export const MOCK_RUNTIME_FILE = '_ddv/mock-runtime.js';

export function mockRuntimeHeader(version = MOCK_VERSION): string {
  return `// @ddv/mock-runtime ${version}`;
}

/** Version from the first line of a deployed runtime, or null when absent. */
export function runtimeVersionOf(text: string): string | null {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  return /@ddv\/mock-runtime\s+v?(\S+)/.exec(first)?.[1] ?? null;
}
