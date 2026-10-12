import type { GitHubError, RestResult } from '@ddv/github';
import type { PatKind } from './pat-format.ts';
import type { PatState } from './pat-store.ts';

/** GitHub write operations (pat.md `GitHubOp`). `OperationId` → `GitHubOp` is in backend/types.ts (`Availability`). */
export type GitHubOp = 'reviewComment' | 'reviewReply' | 'reviewResolve' | 'reviewSubmit' | 'approveStatus' | 'suggestion' | 'actionsDispatch' | 'snapshotApprove';

export const GITHUB_OPS: readonly GitHubOp[] = ['reviewComment', 'reviewReply', 'reviewResolve', 'reviewSubmit', 'suggestion', 'approveStatus', 'actionsDispatch', 'snapshotApprove'];

export type RepoRole = 'pull' | 'push';

export interface OpRequirement {
  /** Name of the operation in the `scopes` list. */
  label: string;
  role: RepoRole;
  /** Fine-grained PAT permissions. */
  fineGrained: string[];
  /** Classic PAT scope for public / private repositories. */
  classic: { public: 'public_repo'; private: 'repo' };
}

const CLASSIC = { public: 'public_repo', private: 'repo' } as const;
const review = (label: string): OpRequirement => ({ label, role: 'pull', fineGrained: ['Pull requests: Write'], classic: CLASSIC });

/** pat.md「必要な権限」. Used to guess the missing permissions of a 403 and to build the `scopes` list. */
export const REQUIRED_PERMISSIONS: Record<GitHubOp, OpRequirement> = {
  reviewComment: review('コメント'),
  reviewReply: review('返信'),
  reviewResolve: review('解決'),
  reviewSubmit: review('レビューの送信'),
  suggestion: review('suggestion'),
  approveStatus: { label: 'Approve の status 連動', role: 'push', fineGrained: ['Contents: Write'], classic: CLASSIC },
  actionsDispatch: { label: 'Actions での実行', role: 'push', fineGrained: ['Actions: Write'], classic: CLASSIC },
  snapshotApprove: { label: '基準画像の承認', role: 'push', fineGrained: ['Actions: Write'], classic: CLASSIC },
};

/** Viewing (no operation): fine-grained permissions. Classic: none for public, `repo` for private. */
export const VIEW_PERMISSIONS = ['Contents: Read', 'Pull requests: Read'];

/** Lines of the `scopes` list (PatForm / PatMenu), built from `REQUIRED_PERMISSIONS`: operations grouped by the same fine-grained permissions. */
export function requiredPermissionLines(): string[] {
  const groups = new Map<string, string[]>();
  for (const op of GITHUB_OPS) {
    const r = REQUIRED_PERMISSIONS[op];
    const key = r.fineGrained.join('、');
    groups.set(key, [...(groups.get(key) ?? []), r.label]);
  }
  return [`閲覧：${VIEW_PERMISSIONS.join('、')}`, ...[...groups].map(([perms, labels]) => `${labels.join('・')}：${perms}`)];
}

export interface RepoAccess {
  pull: boolean;
  push: boolean;
  private: boolean;
  tokenKind: PatKind | null;
  scopes: string[] | null;
}

/** `pending`: `access` is not known yet (probing or failed) — pages-viewer.md GATE shows 権限を確認中です. */
export type MissingReason = 'noPat' | 'role' | 'scope' | 'fineGrained' | 'pending';

export interface MissingPermission {
  reason: MissingReason;
  permissions: string[];
  message: string;
}

export const PERMISSION_PENDING_MESSAGE = '権限を確認中です';

const PERMISSION_NAMES: Record<string, string> = {
  contents: 'Contents',
  pull_requests: 'Pull requests',
  actions: 'Actions',
  metadata: 'Metadata',
  workflows: 'Workflows',
  statuses: 'Commit statuses',
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** `x-accepted-github-permissions` (`contents=write,pull_requests=write; ...`) → `['Contents: Write', 'Pull requests: Write']` (first group only). */
export function parseAcceptedPermissions(header: string | undefined): string[] | null {
  const first = header?.split(';')[0]?.trim();
  if (!first) return null;
  const out = first
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [name, level = ''] = p.split('=').map((s) => s.trim());
      return `${PERMISSION_NAMES[name] ?? capitalize(name)}: ${capitalize(level)}`;
    });
  return out.length ? out : null;
}

interface RepoJson {
  private?: boolean;
  permissions?: { pull?: boolean; push?: boolean };
}

/** What `PermissionProbe` reads of the client (`GitHubClient`). */
export interface RepoHeadersClient {
  restWithHeaders<T>(method: string, path: string): Promise<RestResult<T>>;
}

/** What `PermissionProbe` reads of `PatStore`. */
export interface PatKindView {
  readonly state: PatState;
  readonly kind: PatKind | null;
}

/** Decides whether a GitHub write is possible with the current PAT (pat.md「権限の判定」, DD-PAT-PERM). */
export class PermissionProbe {
  access: RepoAccess | null = null;
  private readonly denied = new Map<GitHubOp, string[]>();

  constructor(
    private readonly client: RepoHeadersClient,
    private readonly pat: PatKindView,
  ) {}

  /** `GET /repos/{o}/{r}` once per target. `PagesBackend` passes the same response to `fromRepo` instead when it already has it. */
  async probe(owner: string, repo: string): Promise<RepoAccess> {
    const r = await this.client.restWithHeaders<RepoJson>('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return this.fromRepo(r.data, r.headers, this.pat.kind);
  }

  fromRepo(json: unknown, headers: Headers, kind: PatKind | null): RepoAccess {
    const j = (json && typeof json === 'object' ? json : {}) as RepoJson;
    const scopesHeader = headers.get('x-oauth-scopes');
    this.access = {
      pull: j.permissions ? j.permissions.pull === true : true,
      push: j.permissions ? j.permissions.push === true : false,
      private: j.private === true,
      tokenKind: kind,
      scopes:
        kind === 'classic'
          ? (scopesHeader ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
    };
    return this.access;
  }

  /** null = the operation can be used. */
  missing(op: GitHubOp): MissingPermission | null {
    const req = REQUIRED_PERMISSIONS[op];
    const a = this.access;
    if (!a) return { reason: 'pending', permissions: [], message: PERMISSION_PENDING_MESSAGE };
    if (this.pat.state === 'none') return { reason: 'noPat', permissions: req.fineGrained, message: `PAT を設定してください（${req.fineGrained.join('、')}）` };
    if (!(req.role === 'push' ? a.push : a.pull)) {
      return { reason: 'role', permissions: ['write'], message: `このリポジトリへの書き込み権限がありません（必要なロール：${req.role === 'push' ? 'Write' : 'Read'}）` };
    }
    if (a.tokenKind === 'classic') {
      const scopes = a.scopes ?? [];
      if (!(scopes.includes('repo') || (!a.private && scopes.includes('public_repo')))) {
        const scope = a.private ? req.classic.private : req.classic.public;
        return { reason: 'scope', permissions: [scope], message: `PAT に ${scope} スコープがありません` };
      }
    }
    const denied = this.denied.get(op);
    if (denied) return { reason: 'fineGrained', permissions: denied, message: `PAT に次の権限がありません：${denied.join('、')}（PAT の設定で追加してください）` };
    return null;
  }

  /** After a 403 of `op`: remembers the permissions it lacks (not for SSO / rate limit). */
  recordDenied(op: GitHubOp, err: GitHubError): void {
    if (err.kind !== 'forbidden' || err.sso) return;
    this.denied.set(op, parseAcceptedPermissions(err.acceptedPermissions) ?? REQUIRED_PERMISSIONS[op].fineGrained);
  }

  /** The PAT or the target changed. */
  reset(): void {
    this.access = null;
    this.denied.clear();
  }
}
