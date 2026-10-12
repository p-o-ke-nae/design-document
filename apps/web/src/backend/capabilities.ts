import { OPERATION_IDS, type Availability, type OperationId } from './types.ts';

/** Local edition: every operation is available (the screens look as before. REQ-610). */
export const LOCAL_CAPABILITIES: Readonly<Record<OperationId, Availability>> = Object.freeze(Object.fromEntries(OPERATION_IDS.map((op) => [op, { kind: 'available' }])) as Record<OperationId, Availability>);

// 理由の文言は pages-viewer.md の「操作の一覧」と同じ
const COMMITTED_ONLY = 'Pages 版はコミット済みの内容だけを表示します';
const SAVE_LOCALLY = 'ファイルの保存はローカル版で行います。PR には suggestion として付けられます';
const RUN_LOCALLY = '手元の ddv で実行してください';
const VIA_ACTIONS = 'Pages 版は Actions で実行します';

/** Pages edition (services.md「使えない操作」). Static: whether a `write` is enabled is `OperationGate.check(op)`. */
export const PAGES_CAPABILITIES: Readonly<Record<OperationId, Availability>> = Object.freeze({
  viewUncommitted: { kind: 'unsupported', reason: COMMITTED_ONLY },
  saveFile: { kind: 'unsupported', reason: SAVE_LOCALLY },
  generateTestIds: { kind: 'unsupported', reason: RUN_LOCALLY },
  lint: { kind: 'unsupported', reason: RUN_LOCALLY },
  scaffold: { kind: 'unsupported', reason: RUN_LOCALLY },
  runLocal: { kind: 'unsupported', reason: VIA_ACTIONS },
  installDeps: { kind: 'unsupported', reason: VIA_ACTIONS },
  snapshotLocal: { kind: 'unsupported', reason: VIA_ACTIONS },
  comment: { kind: 'write', gitHubOp: 'reviewComment' },
  reply: { kind: 'write', gitHubOp: 'reviewReply' },
  resolveThread: { kind: 'write', gitHubOp: 'reviewResolve' },
  submitReview: { kind: 'write', gitHubOp: 'reviewSubmit' },
  suggestTestData: { kind: 'write', gitHubOp: 'suggestion' },
  suggestMock: { kind: 'write', gitHubOp: 'suggestion' },
  approveStatus: { kind: 'write', gitHubOp: 'approveStatus' },
  actionsDispatch: { kind: 'write', gitHubOp: 'actionsDispatch' },
  snapshotApprove: { kind: 'write', gitHubOp: 'snapshotApprove' },
});
