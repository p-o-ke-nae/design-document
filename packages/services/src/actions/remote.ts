import { repoOf } from '../repo-ref.ts';
import type { RepoRef } from './gate.ts';

const SCP = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/;
const SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git+ssh:']);

/** owner / repo of a github.com remote URL (actions-run.md「リモートの判定」); null for anything else. Never throws. */
export function parseGitHubRemote(url: string): RepoRef | null {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (!u) return null;
  let host: string;
  let path: string;
  const scp = u.includes('://') ? null : SCP.exec(u);
  // A one-letter "host" is a Windows drive (C:\...), not scp syntax.
  if (scp && scp[1].length > 1) {
    host = scp[1];
    path = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return null;
    }
    if (!SCHEMES.has(parsed.protocol)) return null;
    host = parsed.hostname;
    try {
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  }
  if (host.toLowerCase() !== 'github.com') return null;
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (trimmed.split('/').length !== 2) return null;
  return repoOf(trimmed);
}
