import type { TokenSetConfig } from '@ddv/core';
import { MemoryTokenFs } from './fs.ts';
import type { ReadResult } from './schema.ts';
import { CssReader } from './css/reader.ts';
import { XamlReader } from './xaml/reader.ts';

export const XAML_HEAD =
  'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" xmlns:sys="clr-namespace:System;assembly=mscorlib"';

/** ResourceDictionary file with the given body. */
export const dict = (body: string) => `<ResourceDictionary ${XAML_HEAD}>\n${body}\n</ResourceDictionary>\n`;

/** App.xaml whose resources are the given body (merged dictionaries and resources). */
export const app = (body: string) => `<Application ${XAML_HEAD} StartupUri="MainWindow.xaml">\n  <Application.Resources>\n    <ResourceDictionary>\n${body}\n    </ResourceDictionary>\n  </Application.Resources>\n</Application>\n`;

export const merged = (...sources: string[]) =>
  `<ResourceDictionary.MergedDictionaries>\n${sources.map((s) => `  <ResourceDictionary Source="${s}" />`).join('\n')}\n</ResourceDictionary.MergedDictionaries>`;

export function xamlSet(over: Partial<TokenSetConfig> = {}): TokenSetConfig {
  return { name: 'order-wpf', kind: 'xaml', sources: ['app/App.xaml'], fontSizeKeys: [], classes: [], elements: [], overrides: {}, out: 'docs/mocks/_tokens/order-wpf.css', optional: false, ...over };
}

export function cssSet(over: Partial<TokenSetConfig> = {}): TokenSetConfig {
  return { name: 'web', kind: 'css', sources: ['web/app/globals.css'], fontSizeKeys: [], classes: [], elements: [], overrides: {}, out: 'docs/mocks/_tokens/web.css', optional: false, ...over };
}

export function readXaml(files: Record<string, string>, over: Partial<TokenSetConfig> = {}): Promise<ReadResult> {
  return new XamlReader().read(xamlSet(over), new MemoryTokenFs(files));
}

export function readCss(files: Record<string, string>, over: Partial<TokenSetConfig> = {}): Promise<ReadResult> {
  return new CssReader().read(cssSet(over), new MemoryTokenFs(files));
}

/** Value of a token by name (`undefined` when absent). */
export const tok = (r: ReadResult, name: string) => r.tokens.find((t) => t.name === name)?.value;
export const messages = (r: ReadResult) => r.warnings.map((w) => w.message);
