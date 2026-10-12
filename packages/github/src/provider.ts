/** Source of the Authorization header used by GitHubClient (local: TokenResolver, Pages: PatStore). */
export interface TokenProvider {
  /** The full header value, or null when no token is available. */
  authorization(): Promise<string | null>;
  /** Called after a 401 on an authorized request. Returns true when the request should be retried once. */
  unauthorized(): boolean;
}
