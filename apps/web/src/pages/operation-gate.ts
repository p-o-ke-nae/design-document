/** Whether an operation can be used (pages-viewer.md「操作の可否」, DD-PAGESV-GATE). */
import type { Availability, Edition, GateResult, OperationId } from '../backend/types.ts';
import { PERMISSION_PENDING_MESSAGE, type GitHubOp, type MissingPermission } from './permission.ts';

/** What `OperationGate` reads of `PermissionProbe`. */
export interface ProbeView {
  readonly access: unknown;
  missing(op: GitHubOp): MissingPermission | null;
}

const ENABLED: GateResult = { enabled: true };

export class OperationGate {
  constructor(
    readonly edition: Edition,
    private readonly capabilities: Readonly<Record<OperationId, Availability>>,
    private readonly probe: ProbeView | null,
  ) {}

  check(op: OperationId): GateResult {
    if (this.edition !== 'pages') return ENABLED;
    const a = this.capabilities[op];
    if (a.kind === 'unsupported') return { enabled: false, reason: a.reason };
    if (a.kind !== 'write') return ENABLED;
    if (!this.probe || this.probe.access === null) return { enabled: false, reason: PERMISSION_PENDING_MESSAGE };
    const missing = this.probe.missing(a.gitHubOp);
    return missing ? { enabled: false, reason: missing.message } : ENABLED;
  }
}
