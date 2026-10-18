import { badgesFor, resultsByPlatform, type BadgeResult } from '../targets.ts';
import { traceHref } from '../state.tsx';

/**
 * Results per platform of one test id (platform-results.md「バッジの表示」). Renders nothing when only web (the old display stays).
 * unning: no trace is opened while a run is going on (desktop-run.md「画面遷移」: 実行中 has no 結果を選ぶ).
 */
export function PlatformBadges({ testId, platforms, latest, running = false }: { testId: string; platforms: string[]; latest: Record<string, BadgeResult>; running?: boolean }) {
  const badges = badgesFor(testId, platforms, resultsByPlatform(latest, testId));
  if (!badges) return null;
  return (
    <span className="platform-badges" data-testid="badges">
      {badges.map((b) => (
        <button
          key={b.platform}
          type="button"
          className={`badge st-${b.mark === '✓' ? 'passed' : b.mark === '✗' ? 'failed' : 'skipped'}`}
          data-testid={`badge-${b.platform}`}
          disabled={!b.trace || running}
          title={b.title}
          onClick={() => b.trace && (location.hash = traceHref(b.trace.runId, b.trace.testId, b.trace.platform))}
        >
          {b.label}
        </button>
      ))}
    </span>
  );
}

/** Whether a row should show badges instead of the old single result. */
export const hasBadges = (testId: string, platforms: string[], latest: Record<string, BadgeResult>) => !!badgesFor(testId, platforms, resultsByPlatform(latest, testId));
