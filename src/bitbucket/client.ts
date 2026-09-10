import { z } from "zod";
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
// Without this, a stalled Bitbucket connection hangs a tool call forever -
// the caller gets no feedback and no way to know something's wrong.
const REQUEST_TIMEOUT_MS = 30_000;

export class BitbucketClient {
  /**
   * `fetchImpl` defaults to the global fetch but can be overridden - the
   * seam that makes every tool handler and the server itself testable
   * without a real network call or a real Bitbucket credential. See
   * test/support/fakeFetch.ts.
   */
  constructor(
    private readonly credentials: CredentialProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * `schema`, when passed, runtime-validates the response against a Zod
   * schema from bitbucket/types.ts (schema.parse()) instead of just trusting
   * the type parameter - catches Bitbucket API drift at the point it
   * happens rather than surfacing as a confusing `undefined` somewhere deep
   * in a tool handler. Purely internal: these schemas are never passed to
   * registerTool's outputSchema, so this costs nothing in wire tokens.
   */
  get<T>(path: string, query?: Record<string, QueryValue>, schema?: z.ZodType<T>): Promise<T> {
    return this.request<T>("GET", path, { query, schema });
  }

  post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>, schema?: z.ZodType<T>): Promise<T> {
    return this.request<T>("POST", path, { body, query, schema });
  }

  put<T>(path: string, body?: unknown, query?: Record<string, QueryValue>, schema?: z.ZodType<T>): Promise<T> {
    return this.request<T>("PUT", path, { body, query, schema });
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
   * Like `post`, but returns status/headers alongside the body instead of
   * just the parsed result - needed where a single endpoint's response
   * shape genuinely depends on the status code (e.g. merge: 200 with the
   * merged PR vs 202 with only a Location header to poll), so the caller
   * must branch on `response.status` before deciding how to interpret the
   * body at all.
   */
  async postWithResponse<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, QueryValue>,
  ): Promise<{ body: T; response: Response }> {
    return this.requestRaw<T>("POST", path, { body, query });
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
    itemSchema?: z.ZodType<T>,
  ): Promise<{ values: T[]; hasMore: boolean }> {
    let next: string | undefined = path;
    let isFirst = true;
    const values: T[] = [];

    while (next && values.length < maxItems) {
      const page: PaginatedResponse<unknown> = await this.request<PaginatedResponse<unknown>>(
        "GET",
        next,
        isFirst ? { query } : undefined,
      );
      const pageValues: unknown[] = page.values;
      values.push(...(itemSchema ? pageValues.map((v) => itemSchema.parse(v)) : (pageValues as T[])));
      next = page.next;
      isFirst = false;
    }

    return { values: values.slice(0, maxItems), hasMore: next !== undefined };
  }

  private async request<T>(
    method: string,
    path: string,
    options?: { query?: Record<string, QueryValue>; body?: unknown; schema?: z.ZodType<T> },
  ): Promise<T> {
    return (await this.requestRaw<T>(method, path, options)).body;
  }

  private async requestRaw<T>(
    method: string,
    path: string,
    options?: { query?: Record<string, QueryValue>; body?: unknown; schema?: z.ZodType<T> },
  ): Promise<{ body: T; response: Response }> {
    const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    const authHeader = await this.credentials.getAuthHeader();
    if (authHeader) {
      headers.Authorization = authHeader;
    }
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new BitbucketApiError(`Bitbucket API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method} ${url.pathname}`, 0);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    if (response.status === 204) {
      return { body: undefined as T, response };
    }

    // Read the body once and check emptiness before branching on
    // content-type: a 2xx with no body at all (e.g. merge's 202-accepted
    // response, which the spec documents as carrying only a Location
    // header) can arrive with or without a content-type set, so checking
    // emptiness only inside the JSON branch would miss it.
    const rawText = await response.text();
    if (rawText.length === 0) {
      return { body: undefined as T, response };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      // diff/patch/raw-file-content endpoints return text/plain
      return { body: rawText as unknown as T, response };
    }

    const json = JSON.parse(rawText);
    return { body: options?.schema ? options.schema.parse(json) : (json as T), response };
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
