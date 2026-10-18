// Hiding connection secrets in reasons and logs (detailed design evidence-runner.md#接続情報の伏せ字).
import type { EvidenceConfig } from './config.ts';

export const MASK = '***';
const MIN_SECRET = 4;

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: readonly string[]) {
    this.secrets = [...new Set(secrets.filter((s) => s.length >= MIN_SECRET))].sort((a, b) => b.length - a.length);
  }

  /** Current values of every `evidence.databases.*.env`. */
  static fromConfig(config: Pick<EvidenceConfig, 'databases'>, env: NodeJS.ProcessEnv = process.env): Redactor {
    return new Redactor(Object.values(config.databases).map((d) => env[d.env] ?? ''));
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join(MASK);
    out = out.replace(/\b(password|pwd)(\s*=\s*)[^;]*/gi, (_m, k: string, eq: string) => `${k}${eq}${MASK}`);
    return out.replace(/(:\/\/[^:/@\s]*:)[^@\s/]*@/g, `$1${MASK}@`);
  }
}
