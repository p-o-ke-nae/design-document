import type { TokenSetConfig } from '@ddv/core';
import { DDV_VERSION, TOKEN_FORMAT, type ReadResult, type SourceRecord, type TokenHeader } from './schema.ts';

const HEADER_FIRST = /^\/\* ddv tokens: ([^（\s]+)（ddv tokens generate が生成。編集しない）$/;
const HEADER_SOURCE = /^ \* source: (.+) sha256=([0-9a-f]{64})$/;
const HEADER_CONFIG = /^ \* config: sha256=([0-9a-f]{64})$/;
const HEADER_BY = /^ \* generated-by: ddv (\S+) format=(\d+)$/;

/** Renders the generated CSS (header, `:root` block, css rules). LF line endings, one trailing newline. */
export class TokenWriter {
  render(set: TokenSetConfig, result: ReadResult, configSha256: string, version = DDV_VERSION, format = TOKEN_FORMAT): string {
    const lines: string[] = [`/* ddv tokens: ${set.name}（ddv tokens generate が生成。編集しない）`];
    for (const s of result.sources) lines.push(` * source: ${s.path} sha256=${s.sha256}`);
    lines.push(` * config: sha256=${configSha256}`, ` * generated-by: ddv ${version} format=${format}`, ' */', ':root {');
    for (const t of result.tokens) lines.push(`  ${t.name}: ${t.value};${t.note ? ` /* ${t.note} */` : ''}`);
    lines.push('}');
    let text = lines.join('\n') + '\n';
    for (const rule of result.rules) text += '\n' + rule.replace(/\r\n?/g, '\n').trim() + '\n';
    return text;
  }
}

/** Reads the header written by `TokenWriter`; `null` when it is missing or broken. */
export function parseHeader(text: string): TokenHeader | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
  const first = HEADER_FIRST.exec(lines[0] ?? '');
  if (!first) return null;
  const sources: SourceRecord[] = [];
  let i = 1;
  for (let m; (m = HEADER_SOURCE.exec(lines[i] ?? '')); i++) sources.push({ path: m[1], sha256: m[2] });
  const config = HEADER_CONFIG.exec(lines[i++] ?? '');
  const by = HEADER_BY.exec(lines[i++] ?? '');
  if (!config || !by || lines[i] !== ' */') return null;
  return { name: first[1], sources, config: config[1], version: by[1], format: Number(by[2]) };
}
