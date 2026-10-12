import YAML from 'yaml';
import { parseConfig, inferDocKind, type DdvConfig, type DocKind } from './config.ts';
import { parseDoc, type ParsedDoc } from './markdown.ts';

export const CONFIG_FILES = ['ddv.config.yaml', 'ddv.config.yml', 'ddv.config.json'];

/** Parses the text of one of CONFIG_FILES (JSON by extension, otherwise YAML). */
export function parseConfigText(name: string, text: string): DdvConfig {
  return parseConfig(name.endsWith('.json') ? JSON.parse(text) : YAML.parse(text));
}

export interface DocEntry {
  path: string;
  kind: DocKind;
  title: string;
  id: string;
  status: string;
  parsed: ParsedDoc;
  text: string;
}

function baseName(rel: string, ext: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return name.endsWith(ext) && name !== ext ? name.slice(0, -ext.length) : name;
}

/** Builds a DocEntry from a repo-relative posix path and its text. */
export function docEntryOf(rel: string, text: string): DocEntry {
  const parsed = parseDoc(text);
  const fm = parsed.frontMatter;
  const base = baseName(rel, '.md');
  return {
    path: rel,
    kind: inferDocKind(rel, fm.kind),
    title: parsed.title || base,
    id: typeof fm.id === 'string' ? fm.id : base.toUpperCase(),
    status: typeof fm.status === 'string' ? fm.status : 'draft',
    parsed,
    text,
  };
}
