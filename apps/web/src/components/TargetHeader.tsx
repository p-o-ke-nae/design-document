import type { HostedTarget } from '../pages/hash-route.ts';
import type { LockWarning } from '../pages/lock-check.ts';
import type { TargetSnapshot } from '../pages/target-loader.ts';
import { useApp } from '../state.tsx';

export function targetText(s: Pick<TargetSnapshot, 'target' | 'defaultBranch' | 'pr'>): string {
  const t: HostedTarget = s.target;
  const repo = `${t.owner}/${t.repo}`;
  if (t.kind === 'pr') return `${repo} #${t.pr}${s.pr ? ` ${s.pr.title}` : ''}`;
  return t.ref ? `${repo} ${t.ref}` : `${repo} ${s.defaultBranch}（既定）`;
}

export function headText(s: Pick<TargetSnapshot, 'pr' | 'commitSha'>): string {
  const sha7 = s.commitSha.slice(0, 7);
  return s.pr ? `${s.pr.baseRef} ← ${s.pr.headRef}（${sha7}）` : sha7;
}

export function permissionText(permission: TargetSnapshot['permission'], hasPat: boolean): string {
  if (!hasPat) return '読み取りのみ（PAT 未設定）';
  return permission === 'write' ? '書き込み可' : '読み取りのみ';
}

/** 文書のヘッダ (pages-viewer.md「画面」): replaces the local `WorkspaceBar`. */
export function TargetHeader({ snapshot, hasPat, lock, onChange }: { snapshot: TargetSnapshot; hasPat: boolean; lock: LockWarning | null; onChange(): void }) {
  const { route } = useApp();
  const warning = route.view === 'doc' && route.path ? lock?.byDoc.get(route.path) : undefined;
  return (
    <div className="target-header">
      <div className="row">
        <strong data-testid="doc-target">{targetText(snapshot)}</strong>
        <span className="muted" data-testid="doc-head">
          {headText(snapshot)}
        </span>
        <span className="muted" data-testid="doc-permission">
          {permissionText(snapshot.permission, hasPat)}
        </span>
        <span className="spacer" />
        <button type="button" data-testid="doc-change" onClick={onChange}>
          対象を変更
        </button>
      </div>
      {warning && (
        <p className="warn" data-testid="lock-warning">
          {warning}
        </p>
      )}
    </div>
  );
}
