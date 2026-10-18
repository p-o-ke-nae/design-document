// Built-in `screenshot` (detailed design evidence-runner.md#screenshot, SHOT).
import path from 'node:path';
import type { EvidenceHost } from '@ddv/mock';
import type { EvidenceContext } from '../index.ts';
import type { ResolvedArgs } from '../with.ts';
import type { CaptureResult, Provider } from './types.ts';

export const FULLPAGE_WEB_ONLY = 'fullPage は Web だけで使えます';
export const TARGET_AND_FULLPAGE = 'target と fullPage は同時に指定できません';

export class ScreenshotProvider implements Provider {
  readonly kind = 'builtin' as const;

  async capture(args: ResolvedArgs, ctx: EvidenceContext, host: EvidenceHost): Promise<CaptureResult> {
    const file = path.join(ctx.outDir, 'shot.png');
    const target = args.target;
    const fullPage = args.fullPage;
    if (target === undefined) {
      if (fullPage === true) {
        if (host.platform !== 'web') throw new Error(FULLPAGE_WEB_ONLY);
        await host.screenshot(file, { fullPage: true });
      } else await host.screenshot(file);
    } else {
      if (fullPage !== undefined) throw new Error(TARGET_AND_FULLPAGE);
      await host.screenshotElement(String(target), file);
    }
    return { outputs: { kind: 'image', path: file } };
  }
}
