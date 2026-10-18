import { badgesFor, resultsByPlatform, type BadgeResult } from '../targets.ts';
import { traceHref } from '../state.tsx';

/** Results per platform of one test id (platform-results.md「バッジの表示」). Renders nothing when only web (the old display stays). */
export function PlatformBadges({ testId, platforms, latest }: { testId: string; platforms: string[]; latest: Record<string, BadgeResult> }) {
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
          disabled={!b.trace}
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
