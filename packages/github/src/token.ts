import { spawn } from 'node:child_process';
import { toGitHubError } from './errors.ts';
import { redact } from './redact.ts';
import type { TokenProvider } from './provider.ts';

export type TokenSource = 'gh' | 'env' | 'none';

export interface ResolvedToken {
  source: TokenSource;
  token: string;
  login: string;
}

export interface AuthStatus {
  source: TokenSource;
  login: string;
  /** Why `none`: no credentials at all, or the token was rejected (401). */
  reason?: 'missing' | 'invalid';
}

export interface TokenResolverOptions {
  /** Runs `gh auth token`; resolves null when gh is unavailable. */
  runGh?: () => Promise<{ code: number; stdout: string } | null>;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  apiBase?: string;
}

export const GH_TIMEOUT_MS = 5000;

/** Runs `gh auth token` without a shell; ENOENT or a 5 s timeout resolve to null. */
export function runGhAuthToken(timeoutMs = GH_TIMEOUT_MS): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: { code: number; stdout: string } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('gh', ['auth', 'token'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.on('error', () => finish(null));
    child.on('close', (code) => finish({ code: code ?? 1, stdout: out }));
  });
}

/** Resolves the GitHub token lazily (TOKEN): `gh auth token` → GITHUB_TOKEN → none, then verifies it with GET /user. */
export class TokenResolver implements TokenProvider {
  private cached: ResolvedToken | null = null;
  private inflight: Promise<ResolvedToken> | null = null;
  private lastReason: AuthStatus['reason'] = 'missing';
  private readonly runGh: NonNullable<TokenResolverOptions['runGh']>;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(opts: TokenResolverOptions = {}) {
    this.runGh = opts.runGh ?? (() => runGhAuthToken());
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  }

  resolve(): Promise<ResolvedToken> {
    if (this.cached) return Promise.resolve(this.cached);
    this.inflight ??= this.doResolve().finally(() => (this.inflight = null));
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
  }

  /** A 401 invalidates the cached token so the client retries once. */
  unauthorized(): boolean {
    this.invalidate();
    return true;
  }

  async status(): Promise<AuthStatus> {
    const t = await this.resolve();
    return t.source === 'none' ? { source: 'none', login: '', reason: this.lastReason } : { source: t.source, login: t.login };
  }

  /** Environment for one git command: the token goes in an http.extraheader config entry, never in args or files. */
  async gitEnv(): Promise<{ env: Record<string, string>; redact: (s: string) => string }> {
    const t = await this.resolve();
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
    if (t.token) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${t.token}`).toString('base64')}`;
    }
    return { env, redact: (s) => redact(s, [t.token]) };
  }

  /** Token for GitHubClient only (kept inside this package). */
  async authorization(): Promise<string | null> {
    const t = await this.resolve();
    return t.token ? `Bearer ${t.token}` : null;
  }

  private async doResolve(): Promise<ResolvedToken> {
    let source: TokenSource = 'none';
    let token = '';
    const gh = await this.runGh().catch(() => null);
    if (gh && gh.code === 0 && gh.stdout.trim()) {
      source = 'gh';
      token = gh.stdout.trim();
    } else if (this.env.GITHUB_TOKEN?.trim()) {
      source = 'env';
      token = this.env.GITHUB_TOKEN.trim();
    } else {
      this.lastReason = 'missing';
      return { source: 'none', token: '', login: '' };
    }
    const res = await this.fetchImpl(`${this.apiBase}/user`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (res.status === 401) {
      this.lastReason = 'invalid';
      return { source: 'none', token: '', login: '' };
    }
    if (!res.ok) {
      const { toGitHubError } = await import('./errors.ts');
      throw toGitHubError(res, await res.json().catch(() => ({})));
    }
    const user = (await res.json()) as { login?: string };
    this.cached = { source, token, login: user.login ?? '' };
    return this.cached;
  }
}
