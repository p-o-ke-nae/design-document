/** An error with the HTTP status / code the API answers with (`{ error, code, message, ...extra }`). */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** A file that cannot be read from a `RepoReader` (missing, a directory, or a path outside the repository). */
export class RepoReadError extends ServiceError {
  constructor(
    readonly status: 404,
    readonly code: 'not-found',
    message: string,
  ) {
    super(status, code, message);
    this.name = 'RepoReadError';
  }
}

export type ReviewErrorCode =
  | 'comment-required'
  | 'comment-too-long'
  | 'body-required'
  | 'body-too-long'
  | 'suggestion-invalid'
  | 'anchor-invalid'
  | 'anchor-not-found'
  | 'drifted'
  | 'invalid-event'
  | 'not-pr'
  | 'not-found'
  | 'stale'
  | 'bad-request';

/** A rejected review operation. `status` is the HTTP status the API answers with. */
export class ReviewError extends ServiceError {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: ReviewErrorCode,
    message: string,
  ) {
    super(status, code, message);
    this.name = 'ReviewError';
  }
}

export const COMMENT_MAX = 2000;
export const BODY_MAX = 5000;

export class HistoryError extends ServiceError {
  constructor(
    readonly status: 404,
    readonly code: string,
    message: string,
  ) {
    super(status, code, message);
    this.name = 'HistoryError';
  }
}

export class TraceError extends ServiceError {
  constructor(
    readonly status: 400 | 500,
    readonly code: string,
    message: string,
  ) {
    super(status, code, message);
    this.name = 'TraceError';
  }
}

export class TestDataError extends ServiceError {
  constructor(
    readonly status: 403 | 404 | 409 | 422 | 500 | 502,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(status, code, message, extra);
    this.name = 'TestDataError';
  }
}
