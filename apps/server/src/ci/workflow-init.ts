import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CiGit, type CiGitLike } from './ci-git.ts';

export type InitStatus = 'created' | 'unchanged' | 'differs' | 'overwritten';

export interface InitWorkflowResult {
  status: InitStatus;
  /** Repository-relative path of the workflow file. */
  path: string;
  diff?: string;
}

export const WORKFLOW_PATH = '.github/workflows/ddv-tests.yml';

/** `plugin/templates/.github/workflows/ddv-tests.yml` of this ddv installation. */
export const TEMPLATE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../plugin/templates', WORKFLOW_PATH);

export class TemplateMissingError extends Error {
  readonly code = 'template-missing';
  constructor(readonly templatePath: string) {
    super(`ddv の雛形が見つかりません: ${templatePath}（ddv のインストールを確認してください）`);
    this.name = 'TemplateMissingError';
  }
}

export interface InitWorkflowOptions {
  force?: boolean;
  template?: string;
  git?: CiGitLike;
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const lines = (s: string) => (s ? lf(s).replace(/\n$/, '').split('\n').length : 0);

/** Places the ddv workflow (DD-ACTWF-INIT). Never commits. */
export async function initWorkflow(repoRoot: string, opts: InitWorkflowOptions = {}): Promise<InitWorkflowResult> {
  const template = opts.template ?? TEMPLATE_PATH;
  let text: string;
  try {
    text = lf(await fs.readFile(template, 'utf8'));
  } catch {
    throw new TemplateMissingError(template);
  }
  const target = path.join(repoRoot, WORKFLOW_PATH);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(target, 'utf8');
  } catch {
    existing = null;
  }
  if (existing === null) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
    return { status: 'created', path: WORKFLOW_PATH };
  }
  if (lf(existing) === text) return { status: 'unchanged', path: WORKFLOW_PATH };
  if (opts.force) {
    await fs.writeFile(target, text, 'utf8');
    return { status: 'overwritten', path: WORKFLOW_PATH };
  }
  const git = opts.git ?? new CiGit();
  const d = await git.run(['diff', '--no-index', '--no-color', '--', target, template], { cwd: repoRoot });
  const diff = d.code === 1 && d.stdout ? d.stdout : `（差分を表示できません。行数 既存 ${lines(existing)} / 雛形 ${lines(text)}）`;
  return { status: 'differs', path: WORKFLOW_PATH, diff };
}
