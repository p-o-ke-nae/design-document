import path from 'node:path';
import { devOriginsFromEnv } from './guard.ts';
import { parseOpenRequest, type OpenRequest } from './workspaces.ts';

export interface ServeArgs {
  initial: 'none' | 'repo' | 'last';
  /** `initial: 'repo'`: absolute path (relative paths are resolved against cwd). */
  repo?: string;
  openBrowser: boolean;
  port: number;
  host: string;
  devOrigins: string[];
  github?: OpenRequest;
}

export class ServeArgsError extends Error {}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `ddv serve` options (SERVEARGS). Throws `ServeArgsError` / `OpenRequestError` (exit code 2). */
export function parseServeArgs(argv: string[], cwd: string, env: Record<string, string | undefined> = process.env): ServeArgs {
  const hasRepo = argv.includes('--repo');
  const hasLast = argv.includes('--last');
  if (hasRepo && hasLast) throw new ServeArgsError('--repo と --last は同時に指定できません');
  let initial: ServeArgs['initial'] = 'none';
  let repo: string | undefined;
  if (hasRepo) {
    const v = arg(argv, '--repo');
    if (!v || v.startsWith('--')) throw new ServeArgsError('--repo にパスを指定してください');
    initial = 'repo';
    repo = path.resolve(cwd, v);
  } else if (hasLast) initial = 'last';
  let github: OpenRequest | undefined;
  const githubRepo = arg(argv, '--github');
  if (githubRepo) {
    github = { repo: githubRepo, pr: arg(argv, '--pr'), ref: arg(argv, '--ref') };
    parseOpenRequest(github);
  }
  const devOrigin = arg(argv, '--dev-origin');
  return {
    initial,
    ...(repo ? { repo } : {}),
    openBrowser: argv.includes('--open'),
    port: Number(arg(argv, '--port') ?? env.DDV_PORT ?? 5178),
    host: arg(argv, '--host') ?? '127.0.0.1',
    devOrigins: [...devOriginsFromEnv(env), ...(devOrigin ? [devOrigin] : [])],
    ...(github ? { github } : {}),
  };
}
