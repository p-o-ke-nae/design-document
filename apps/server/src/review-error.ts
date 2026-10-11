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
export class ReviewError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: ReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export const COMMENT_MAX = 2000;
export const BODY_MAX = 5000;
