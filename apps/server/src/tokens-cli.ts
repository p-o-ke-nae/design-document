import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@ddv/core/node';
import { checkTokensDetailed, formatReport, generateTokensAt, hasErrors } from '@ddv/tokens/node';

export const TOKENS_HELP = `ddv tokens generate [--name <name>] [--repo <path>]
      設定の tokens から実アプリのデザインのトークン（<mocksRoot>/_tokens/<name>.css）を生成します（--name 省略時はすべて）
  ddv tokens check [--repo <path>]
      トークンの生成物と生成元の乖離を検査します（ddv-lint と同じ判定。warning があれば終了コード 1）
      環境変数 DDV_TOKENS_OPTIONAL=1: 生成元が見つからないときは情報として表示します`;

export interface TokensIo {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  help: string;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `ddv tokens <generate|check>` (`TCLI`). Returns the exit code. */
export async function tokensCommand(argv: string[], io: TokensIo): Promise<number> {
  const sub = argv[0];
  if (sub !== 'generate' && sub !== 'check') {
    io.err(`不明なサブコマンド: tokens ${sub ?? ''}\n\n${io.help}`);
    return 2;
  }
  const repo = path.resolve(io.cwd, arg(argv, '--repo') ?? '.');
  if (!existsSync(repo)) {
    io.err(`リポジトリが見つかりません: ${repo}`);
    return 2;
  }
  const config = await loadConfig(repo);
  if (sub === 'generate') {
    const report = await generateTokensAt(repo, config, { name: arg(argv, '--name') });
    const text = formatReport(report);
    if (text) io.out(text);
    return hasErrors(report) ? 1 : 0;
  }
  const { issues, infos } = await checkTokensDetailed(repo, config);
  for (const i of infos) io.out(i);
  for (const i of issues) io.out(`${i.severity}: ${i.path} [${i.rule}] ${i.message}`);
  if (!issues.length) io.out('✓ トークンの乖離はありません');
  return issues.length ? 1 : 0;
}
