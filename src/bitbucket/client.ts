import { CredentialProvider } from "../credentials.js";

/**
 * Thrown for any non-2xx Bitbucket response. Carries the scope-introspection
 * headers Bitbucket returns on every call (x-oauth-scopes / x-accepted-oauth-scopes)
 * so callers can build an actionable "you're missing scope X" message instead
 * of a bare status code.
 */
export class BitbucketApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly acceptedScopes?: string,
    public readonly grantedScopes?: string,
    public readonly retryAfterSeconds?: string,
  ) {
    super(message);
    this.name = "BitbucketApiError";
  }
}

export interface PaginatedResponse<T> {
  size?: number;
  page?: number;
  pagelen?: number;
  next?: string;
  previous?: string;
  values: T[];
}

type QueryValue = string | number | boolean | undefined;

const BASE_URL = "https://api.bitbucket.org/2.0";

export class BitbucketClient {
  constructor(private readonly credentials: CredentialProvider) {}

  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }

  put<T>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>("PUT", path, { body, query });
  }

  delete<T = void>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>("DELETE", path, { query });
  }

  /**
   * Like `get`, but also returns the raw Response so callers can read
   * response headers (used by scopeProbe.ts to read x-oauth-scopes off a
   * successful call - the only place in the codebase that needs headers
   * from a 2xx response rather than just the body).
   */
  async getWithResponse<T>(
    path: string,
    query?: Record<string, QueryValue>,
  ): Promise<{ body: T; response: Response }> {
    return this.requestRaw<T>("GET", path, { query });
  }

  /**
   * Follows `next` verbatim rather than constructing page URLs (Bitbucket
   * reserves the right to change the pagination shape per endpoint - see
   * bitbucket-api-contract.md). Stops once `maxItems` is reached or the last
   * page is hit; `hasMore` tells the caller whether it stopped early.
   */
  async paginate<T>(
    path: string,
    query: Record<string, QueryValue> | undefined,
    maxItems: number,
  ): Promise<{ values: T[]; hasMore: boolean }> {
    let next: string | undefined = path;
    let isFirst = true;
    const values: T[] = [];

    while (next && values.length < maxItems) {
      const page: PaginatedResponse<T> = await this.request<PaginatedResponse<T>>(
        "GET",
        next,
        isFirst ? { query } : undefined,
      );
      values.push(...page.values);
      next = page.next;
      isFirst = false;
    }

    return { values: values.slice(0, maxItems), hasMore: next !== undefined };
  }

  private async request<T>(
    method: string,
    path: string,
    options?: { query?: Record<string, QueryValue>; body?: unknown },
  ): Promise<T> {
    return (await this.requestRaw<T>(method, path, options)).body;
  }

  private async requestRaw<T>(
    method: string,
    path: string,
    options?: { query?: Record<string, QueryValue>; body?: unknown },
  ): Promise<{ body: T; response: Response }> {
    const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: await this.credentials.getAuthHeader(),
      Accept: "application/json",
    };
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    if (response.status === 204) {
      return { body: undefined as T, response };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      // diff/patch endpoints return text/plain
      return { body: (await response.text()) as unknown as T, response };
    }
    return { body: (await response.json()) as T, response };
  }

  private async toApiError(response: Response): Promise<BitbucketApiError> {
    const acceptedScopes = response.headers.get("x-accepted-oauth-scopes") ?? undefined;
    const grantedScopes = response.headers.get("x-oauth-scopes") ?? undefined;
    const retryAfterSeconds = response.headers.get("retry-after") ?? undefined;

    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? "";
    } catch {
      // Response body wasn't JSON (or was empty) - fall back to the status line alone.
    }

    let message = `Bitbucket API error ${response.status}`;
    if (detail) message += `: ${detail}`;
    if (response.status === 403 && acceptedScopes) {
      message += grantedScopes
        ? ` (this credential has scope(s) [${grantedScopes}], this operation requires [${acceptedScopes}])`
        : ` (this operation requires scope(s) [${acceptedScopes}])`;
    }
    if (response.status === 429 && retryAfterSeconds) {
      message += ` (rate limited - retry after ${retryAfterSeconds}s)`;
    }

    return new BitbucketApiError(message, response.status, acceptedScopes, grantedScopes, retryAfterSeconds);
  }
}
