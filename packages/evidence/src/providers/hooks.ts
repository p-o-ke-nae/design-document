// Evidence functions of e2e/ddv-hooks.ts (detailed design evidence-runner.md#hooks-の関数, HOOKCALL).
import type { EvidenceContext, EvidenceDefinition } from '../index.ts';
import type { ResolvedArgs } from '../with.ts';
import { isOutputLike, type CaptureResult, type Provider } from './types.ts';

export const BAD_SHAPE = '戻り値の形が不正です';
export const missingArgMessage = (name: string) => `必須の引数 ${name} がありません`;

/** Fills `default`s of `params` and checks required ones (throws on the first missing one). */
export function fillParams(params: Record<string, { required?: boolean; default?: unknown }>, args: ResolvedArgs): ResolvedArgs {
  const out: ResolvedArgs = { ...args };
  for (const [name, def] of Object.entries(params)) {
    if (out[name] !== undefined) continue;
    if (def.default !== undefined) out[name] = def.default as ResolvedArgs[string];
    else if (def.required) throw new Error(missingArgMessage(name));
  }
  return out;
}

export class HooksProvider implements Provider {
  readonly kind = 'hooks' as const;
  readonly timeout?: number;

  constructor(private readonly def: EvidenceDefinition) {
    if (def.timeout !== undefined) this.timeout = def.timeout;
  }

  async capture(args: ResolvedArgs, ctx: EvidenceContext): Promise<CaptureResult> {
    const filled = fillParams(this.def.params ?? {}, args);
    const out = await this.def.run(filled, ctx);
    if (!isOutputLike(out)) throw new Error(BAD_SHAPE);
    return { outputs: out };
  }
}
