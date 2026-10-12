import { createHash } from 'node:crypto';
import type { DdvConfig } from '@ddv/core';
import { systemEnv, TestDataService as ServicesTestDataService, type Reviewer as ServicesReviewer, type TestDataWorkspace as ServicesTestDataWorkspace } from '@ddv/services';
import { FsRepoReader, FsRepoWriter } from './fs-reader.ts';
import type { ReviewTarget } from './review.ts';
import { fsMockService } from './scenarios.ts';

/** Moved to @ddv/services (testdata.ts); this adapter reads / writes the working folder `repoRoot`. */
export {
  issuePath,
  READONLY_BRANCH,
  READONLY_NO_WRITER,
  READONLY_RETIRED,
  rowKeyField,
  scenarioAfter,
  suggestionOf,
  tableDefs,
  TestDataError,
  type DataIssue,
  type FileData,
  type FileDiff,
  type FixtureTables,
  type IssueCode,
  type MockInfo,
  type Row,
  type SaveMode,
  type SaveResult,
  type TableDef,
  type TestDataBundle,
  type TestDataDraft,
  type ValidationResult,
  type WorkspaceKind,
} from '@ddv/services';

export type TestDataWorkspace<T extends { headSha: string } = ReviewTarget> = ServicesTestDataWorkspace<T>;
export type Reviewer<T extends { headSha: string } = ReviewTarget> = ServicesReviewer<T>;

export const hashOf = (text: string | Buffer) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export class TestDataService<T extends { headSha: string } = ReviewTarget> extends ServicesTestDataService<T> {
  constructor(repoRoot: string, config: DdvConfig, review?: Reviewer<T>) {
    const reader = new FsRepoReader(repoRoot);
    super({ reader, writer: new FsRepoWriter(reader), getConfig: () => config, env: systemEnv, mocks: fsMockService(repoRoot, config) }, review);
  }
}