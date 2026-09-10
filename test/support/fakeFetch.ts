/**
 * A minimal fake `fetch` for unit/e2e tests - no mocking library, just a
 * plain function matching the same seam BitbucketClient already accepts
 * (see bitbucket/client.ts's constructor). Routes are checked in order;
 * each is a plain function so a test can close over mutable state (e.g.
 * "return 202 on the first call, SUCCESS on the second") without needing
 * a stateful mocking framework.
 */

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  /** A plain object/array is JSON-serialized with an application/json content-type; a string is sent as-is with text/plain (matches how Bitbucket serves diff/patch/raw file content). */
  body?: unknown;
}

export type FakeRoute = (url: URL, init: RequestInit | undefined) => FakeResponse | undefined;

/**
 * Routes are consumed in order: the first one whose matcher returns a
 * response is removed from the pool before returning it, so listing the
 * same endpoint's route twice naturally simulates "first call gets X,
 * second call gets Y" (e.g. merge's 202-then-SUCCESS poll sequence) without
 * needing separate stateful-mock machinery.
 */
export function createFakeFetch(routes: FakeRoute[]): typeof fetch {
  const pool = [...routes];
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlString = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(urlString);

    for (let i = 0; i < pool.length; i++) {
      const result = pool[i](url, init);
      if (result === undefined) continue;
      pool.splice(i, 1);

      const status = result.status ?? 200;
      const isTextBody = typeof result.body === "string";
      const headers = new Headers(result.headers ?? {});
      if (result.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", isTextBody ? "text/plain" : "application/json");
      }
      const bodyText = result.body === undefined ? "" : isTextBody ? (result.body as string) : JSON.stringify(result.body);
      if (bodyText.length > 0 && !headers.has("content-length")) {
        headers.set("content-length", String(bodyText.length));
      }
      return new Response(bodyText.length > 0 ? bodyText : null, { status, headers });
    }

    throw new Error(`fakeFetch: no route matched ${init?.method ?? "GET"} ${url.pathname}${url.search}`);
  }) as typeof fetch;
}

/** Matches one method+pathname exactly, ignoring query string - the common case for a single-endpoint test. */
export function route(method: string, pathname: string, response: FakeResponse): FakeRoute {
  return (url, init) => {
    const actualMethod = (init?.method ?? "GET").toUpperCase();
    if (actualMethod !== method.toUpperCase() || url.pathname !== pathname) return undefined;
    return response;
  };
}
