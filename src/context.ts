import { BitbucketClient } from "./bitbucket/client.js";

/**
 * Passed to every tool handler instead of a bare BitbucketClient. Deliberately
 * an object, not just the client, so an `elicit()` method can be added here
 * later (server asks the client mid-call for structured input/confirmation)
 * without changing any existing handler's signature - only the specific
 * handlers that start using it (merge/decline/delete) would change. Not
 * built yet; this is the reserved seam for it.
 */
export interface RequestContext {
  bitbucket: BitbucketClient;
  /** See Config.defaultWorkspace. Resolve per-call via tools/toolHelpers.ts's resolveWorkspace(). */
  defaultWorkspace?: string;
}
