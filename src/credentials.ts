/**
 * Single seam between "how we authenticate" and everything else. Every
 * outbound Bitbucket request asks a CredentialProvider for the current
 * Authorization header value - nothing else in the codebase touches tokens,
 * env vars, or auth logic directly.
 *
 * v1 ships one implementation (a static token). Adding OAuth later means
 * writing a second implementation of this same interface (browser flow,
 * refresh-token renewal, secure local storage) and swapping it in at the
 * composition root in index.ts - no tool, client, or gating code changes.
 */
export interface CredentialProvider {
  /**
   * Full `Authorization` header value, e.g. "Bearer abc123". Returns
   * undefined for fully unauthenticated requests - Bitbucket serves public
   * repos to anonymous callers, but rejects a garbage/expired credential
   * outright rather than falling back to anonymous access, so "no header"
   * and "a bad header" are genuinely different states or every public-repo
   * read errors instead of succeeding.
   */
  getAuthHeader(): Promise<string | undefined>;
}

export class StaticTokenCredentialProvider implements CredentialProvider {
  constructor(private readonly token: string) {}

  async getAuthHeader(): Promise<string> {
    return `Bearer ${this.token}`;
  }
}

/** Fully anonymous access - only public repos/endpoints will work. */
export class NoCredentialProvider implements CredentialProvider {
  async getAuthHeader(): Promise<undefined> {
    return undefined;
  }
}
