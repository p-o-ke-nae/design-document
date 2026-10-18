import type { TokenSetConfig } from '@ddv/core';

export type { TokenSetConfig } from '@ddv/core';

/** Version of the conversion rules written as `format=` in the header. Raise only when the output rules change. */
export const TOKEN_FORMAT = 1;
/** ddv version written as `generated-by: ddv <version>` (not compared by the drift check). */
export const DDV_VERSION = '0.1.0';

export type TokenKind = 'color' | 'font-family' | 'font-size' | 'thickness' | 'corner-radius' | 'standard' | 'css';
export type TokenOrigin = 'defined' | 'wpf-default' | 'override';

export interface Token {
  /** CSS custom property name including `--`. */
  name: string;
  value: string;
  kind: TokenKind;
  origin: TokenOrigin;
  /** Trailing comment such as `WPF 標準`, `override` or `@theme inline`. */
  note?: string;
}

export interface SourceRecord {
  /** Repository-relative posix path (may start with `..`). */
  path: string;
  sha256: string;
}

export interface TokenWarning {
  file?: string;
  line?: number;
  message: string;
}

export interface ReadResult {
  tokens: Token[];
  /** css only: imported at-rules, element rules and shared classes in source order. */
  rules: string[];
  sources: SourceRecord[];
  warnings: TokenWarning[];
  /** Errors that prevent writing the set (an entry file cannot be read). */
  errors: string[];
  /** Definitions that lost to another definition of the same key / variable. */
  dropped: number;
  /** Definitions out of scope (counted only). */
  skipped: number;
}

export interface TokenHeader {
  name: string;
  sources: SourceRecord[];
  config: string;
  version: string;
  format: number;
}

export function emptyResult(): ReadResult {
  return { tokens: [], rules: [], sources: [], warnings: [], errors: [], dropped: 0, skipped: 0 };
}

/** SHA-256 (hex) of the text with line endings normalized to LF. WebCrypto only (browser-safe). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.replace(/\r\n?/g, '\n'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON with object keys sorted and `undefined` dropped. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** Hash of the generation settings recorded as `config: sha256=…` (name and optional excluded). */
export function configHash(set: TokenSetConfig): Promise<string> {
  const { kind, sources, prefix, fontSizeKeys, classes, elements, overrides, out } = set;
  return sha256Hex(canonicalJson({ kind, sources, prefix, fontSizeKeys, classes, elements, overrides, out }));
}
