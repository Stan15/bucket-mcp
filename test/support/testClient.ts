import { BitbucketClient } from "../../src/bitbucket/client.js";
import { StaticTokenCredentialProvider } from "../../src/credentials.js";
import { FakeRoute, createFakeFetch } from "./fakeFetch.js";

/** A BitbucketClient wired to a fake fetch - no network, no real token needed. */
export function testBitbucketClient(routes: FakeRoute[]): BitbucketClient {
  return new BitbucketClient(new StaticTokenCredentialProvider("test-token"), createFakeFetch(routes));
}
