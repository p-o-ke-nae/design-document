import { targetLabel, type HostedTarget } from '../pages/hash-route.ts';
import type { LoadProgress, LoadStep, RateMeter } from '../pages/target-loader.ts';
import { RateText } from './PagesTopBar.tsx';

const STEPS: LoadStep[] = ['info', 'tree', 'files', 'build'];

function stepText(step: LoadStep, target: HostedTarget, p: LoadProgress): string {
  switch (step) {
    case 'info':
      return target.kind === 'pr' ? 'PR 情報' : 'リポジトリ情報';
    case 'tree':
      return 'ファイル一覧（Trees API）';
    case 'files':
      return p.total ? `設計書・ロック・設定（${p.done} / ${p.total} 件、うちキャッシュ ${p.cached} 件）` : '設計書・ロック・設定';
    case 'build':
      return '文書の組み立て';
  }
}

/** 取得中 (pages-viewer.md「画面」): the steps of `TargetLoader.progress`. */
export function TargetLoadingPage({ target, progress, rate }: { target: HostedTarget; progress: LoadProgress; rate: RateMeter }) {
  const now = progress.step ? STEPS.indexOf(progress.step) : 0;
  return (
    <main className="main doc pages-loading">
      <h2 data-testid="loading-target">{targetLabel(target)} を取得中</h2>
      <ul className="progress" data-testid="progress">
        {STEPS.map((s, i) => (
          <li key={s} className={i < now ? 'done' : i === now ? 'now' : ''} data-step={s}>
            {stepText(s, target, progress)}
          </li>
        ))}
      </ul>
      <p>
        <RateText rate={rate} testid="loading-rate" withReset />
      </p>
    </main>
  );
}
