const LABEL: Record<string, string> = { passed: '成功', failed: '失敗', skipped: 'スキップ', error: 'エラー', running: '実行中' };

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  return (
    <span className={`badge st-${status}`} title={title} data-testid="status-badge" data-status={status}>
      {LABEL[status] ?? status}
    </span>
  );
}
