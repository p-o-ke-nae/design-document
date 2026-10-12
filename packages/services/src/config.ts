import { CONFIG_FILES, parseConfig, parseConfigText, type DdvConfig } from '@ddv/core';
import type { RepoReader } from './repo-reader.ts';

/** `loadConfig` over a `RepoReader`: the first of `CONFIG_FILES` that exists, else the defaults. */
export async function loadConfigFrom(reader: RepoReader): Promise<DdvConfig> {
  for (const name of CONFIG_FILES) {
    const text = await reader.tryReadText(name);
    if (text !== null) return parseConfigText(name, text);
  }
  return parseConfig({});
}
