import { GitHubError } from '@ddv/github';
import type { PatView } from '../backend/types.ts';
import { PAT_INVALID_MESSAGE } from './pat-store.ts';
import type { MissingPermission } from './permission.ts';

export const SSO_REQUIRED_MESSAGE = 'この組織では PAT の SSO 承認が必要です（GitHub の PAT の設定で「Configure SSO」から承認してください）';
export const RATE_LIMIT_PAT_HINT = 'PAT を設定すると上限が上がります';

const redactWith = (store: PatView, text: string) => (store.redact ? store.redact(text) : text);

/**
 * The Pages edition's display text of an error (pat.md「漏らさないための規則」). Always passed through `store.redact`.
 * `missing`: the `MissingPermission` of the operation that got the 403 (only while operating).
 */
export function formatGitHubError(e: unknown, store: PatView, missing?: MissingPermission | null): string {
  if (!(e instanceof GitHubError)) return redactWith(store, e instanceof Error ? e.message : String(e));
  if (e.kind === 'auth' && store.lastClear === 'invalid') return PAT_INVALID_MESSAGE;
  if (e.kind === 'forbidden' && e.sso) return SSO_REQUIRED_MESSAGE;
  if (e.kind === 'forbidden' && missing) return missing.message;
  const message = redactWith(store, e.message);
  if (e.kind === 'rateLimit' && store.state === 'none') return `${message}。${RATE_LIMIT_PAT_HINT}`;
  return message;
}
