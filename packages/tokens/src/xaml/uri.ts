import { basename, dirname, joinPath, type TokenFs } from '../fs.ts';

export type UriResolution = { ok: true; path: string } | { ok: false; warning: string };

interface ProjectIndex {
  /** Lower-cased assembly name → project directory. */
  assemblies: Map<string, string>;
  projectDirs: Set<string>;
}

const PACK_PREFIX = /^pack:\/\/application:,,,/i;
const COMPONENT = /^\/?([^/;]+)(?:;[^/;]*)*;component\/(.*)$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Maps a `ResourceDictionary.Source` URI to a repository path. */
export class XamlUriResolver {
  private index: Promise<ProjectIndex> | null = null;
  constructor(private readonly fs: TokenFs) {}

  /** `*.csproj` of the repository (bin, obj and node_modules excluded), built once. */
  private assemblyIndex(): Promise<ProjectIndex> {
    this.index ??= (async () => {
      const assemblies = new Map<string, string>();
      const projectDirs = new Set<string>();
      for (const proj of await this.fs.glob('**/*.csproj')) {
        const text = (await this.fs.read(proj)) ?? '';
        const m = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/i.exec(text);
        const name = m ? m[1] : basename(proj).replace(/\.csproj$/i, '');
        const dir = dirname(proj);
        projectDirs.add(dir);
        if (!assemblies.has(name.toLowerCase())) assemblies.set(name.toLowerCase(), dir);
      }
      return { assemblies, projectDirs };
    })();
    return this.index;
  }

  /** Directory of the first `*.csproj` found walking up from `file` (`null` when none). */
  async projectDirOf(file: string): Promise<string | null> {
    const { projectDirs } = await this.assemblyIndex();
    const lower = new Map([...projectDirs].map((d) => [d.toLowerCase(), d]));
    let dir = dirname(file);
    for (;;) {
      const hit = lower.get(dir.toLowerCase());
      if (hit !== undefined) return hit;
      if (dir === '' || dir === '..' || dir.endsWith('/..')) return null;
      dir = dirname(dir);
    }
  }

  async resolve(uri: string, fromFile: string, entryProject: string | null): Promise<UriResolution> {
    let rest = uri.trim();
    if (PACK_PREFIX.test(rest)) rest = rest.replace(PACK_PREFIX, '');
    const comp = COMPONENT.exec(rest);
    if (comp) {
      const dir = (await this.assemblyIndex()).assemblies.get(comp[1].toLowerCase());
      if (dir === undefined) return { ok: false, warning: `外部のアセンブリは辿りません: ${uri}` };
      return { ok: true, path: joinPath(dir, comp[2]) };
    }
    if (rest.startsWith('/')) return { ok: true, path: joinPath(entryProject ?? '', rest.slice(1)) };
    if (SCHEME.test(rest)) return { ok: false, warning: `対応していない URI です: ${uri}` };
    return { ok: true, path: joinPath(dirname(fromFile), rest) };
  }
}
