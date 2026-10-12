/** Whether Actions are shown / runnable (actions-run.md「可否の判定」). Pure: never calls GitHub. */

export interface RepoRef {
  owner: string;
  repo: string;
}

export type ActionsGateState = 'hidden' | 'setup' | 'fork' | 'readonly' | 'ready';

export type ActionsEdition = 'local' | 'pages';

export interface ActionsGateInput {
  remote: RepoRef | null;
  /** The ddv workflow on the default branch: null = could not be checked. */
  workflow: boolean | null;
  fork: boolean;
  canPush: boolean;
  authenticated: boolean;
  lookupError?: string;
  defaultBranch?: string;
  /** Wording of the readonly reasons (default local). */
  edition?: ActionsEdition;
}

export interface ActionsGateResult {
  state: ActionsGateState;
  reason: string;
}

export const DDV_WORKFLOW_FILE = 'ddv-tests.yml';
export const DDV_WORKFLOW_PATH = '.github/workflows/ddv-tests.yml';
export const RESULTS_BRANCH = 'ddv-results';

export const GATE_MESSAGES = {
  setup: (defaultBranch: string) => `既定ブランチ（${defaultBranch}）に ddv ワークフロー（${DDV_WORKFLOW_PATH}）がありません`,
  fork: 'fork からの PR は Actions で実行しません。PR の CI の結果を表示します',
  loginLocal: 'GitHub にログインしてください（gh auth login または GITHUB_TOKEN）',
  loginPages: 'PAT を設定すると Actions の結果と実行が使えます',
  noPat: 'PAT が無いため実行できません。実行済みの結果だけを表示します',
  noPush: '書き込み権限が無いため実行できません。実行済みの結果だけを表示します',
} as const;

export function actionsGate(input: ActionsGateInput): ActionsGateResult {
  if (!input.remote) return { state: 'hidden', reason: '' };
  if (input.workflow === null) {
    if (!input.authenticated) return { state: 'readonly', reason: input.edition === 'pages' ? GATE_MESSAGES.loginPages : GATE_MESSAGES.loginLocal };
    return { state: 'readonly', reason: input.lookupError ?? '' };
  }
  if (input.workflow === false) return { state: 'setup', reason: GATE_MESSAGES.setup(input.defaultBranch ?? '') };
  if (input.fork) return { state: 'fork', reason: GATE_MESSAGES.fork };
  if (!input.canPush) return { state: 'readonly', reason: input.authenticated ? GATE_MESSAGES.noPush : GATE_MESSAGES.noPat };
  return { state: 'ready', reason: '' };
}
