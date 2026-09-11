# bucket-mcp

An MCP server for Bitbucket Cloud — code review and PR workflows (repos, pull requests, commits, branches, file browsing, code search, workspace/user discovery) for Claude Code, Codex, Cursor, and any other MCP-capable agent.

## Setup

```bash
npx bucket-mcp configure
```

One guided command: it walks you through creating a Bitbucket API token (pointing you to a [scope guide](#token-scopes-by-use-case) to help you choose), validates it live, lets you pick a default workspace from your real list, asks which permission mode you want, then asks which agent to configure it for. Claude Code and Codex CLI register automatically via their own CLI (`claude mcp add` / `codex mcp add`); Cursor, OpenCode, GitHub Copilot, and Pi Agent get their config file written automatically too, detecting which one you actually use where more than one is possible. Only "my agent isn't listed" falls back to a config block you paste in yourself. Restart your agent afterward and the tools are available.

Prefer to do it by hand, or want to see exactly what gets registered? See [Manual setup](#manual-setup) below.

Run it again any time to change your token, default workspace, or permission mode. It shows what you're currently configured as, pre-fills every question with that, and lets you keep your existing token instead of pasting it again — then replaces the old registration with the new one rather than erroring on a name collision.

## Uninstalling

```bash
npx bucket-mcp uninstall
```

Removes the Bitbucket MCP server from Claude Code. Equivalent to `claude mcp remove bitbucket` by hand.

## Permission modes

Set via `BITBUCKET_MCP_MODE`, or picked during `configure`:

| Mode | What it allows |
| --- | --- |
| `readonly` | No write or destructive tool of any kind. |
| `draft` (default) | Can create draft PRs and pending comments/tasks — nothing else that writes. A draft PR is visible to teammates, just marked not-ready-for-review; a pending comment/task is invisible to everyone but its author until they submit their review in Bitbucket's own UI. Either way, a human still has to mark it ready or submit it in Bitbucket before anyone else can act on it — this mode can't do that step. |
| `readwrite` | Full access, including merge/decline/delete. PRs and comments/tasks you create still default to draft/pending — pass `draft:false` / `pending:false` explicitly to make one live immediately. |

`BITBUCKET_MCP_READONLY=1` still works as an alias for `mode=readonly`, for anyone who set it before `BITBUCKET_MCP_MODE` existed.

## Token scopes by use case

On the "Select Bitbucket scopes" screen, search each name below and check it:

| Use case | Scopes to check |
| --- | --- |
| **Read-only** | `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `read:user:bitbucket`, `read:workspace:bitbucket` |
| **Draft** (default) / **Read-write** | everything above, plus `write:repository:bitbucket`, `write:pullrequest:bitbucket` |

Draft and Read-write need the same token scopes — Bitbucket has no separate scope for "write, but only drafts." The difference between those two modes is enforced by `BITBUCKET_MCP_MODE` itself, not the token: a write-scoped token used in draft mode still can't merge or approve anything, because those tools aren't registered in that mode.

## Rotating your token

Bitbucket API tokens expire (max 1 year) and can't be edited after creation — only replaced. Re-run `configure` with the new token, or update the `BITBUCKET_API_TOKEN` value directly in Claude Code's MCP config, then restart Claude Code.

## Updating

Restart Claude Code — `npx` re-resolves `bucket-mcp`'s latest published version each launch. This only picks up an actual release, not every commit to `main`; check [npm](https://www.npmjs.com/package/bucket-mcp) if you're not sure whether the fix you want has shipped yet.

## Troubleshooting

- **A tool call fails with "this operation requires scope(s) [...]"** — your token doesn't have that scope. Create a new one with it added and re-run `configure`.
- **Tools you expect are missing from the list** — check your `BITBUCKET_MCP_MODE`, and check your token's scopes.
- **"No workspace specified..." error** — either pass `workspace` explicitly, set `BITBUCKET_DEFAULT_WORKSPACE`, or ask the AI to call `bitbucket_workspace_list` first.

## Manual setup (Claude Code)

Setting up a different agent by hand? Run `configure`, answer the prompts, and pick "My agent isn't listed" at the end — it prints the same standard MCP config block without registering anything for you.

### 1. Get a Bitbucket API token

1. Bitbucket → avatar → **Account settings** → **Security** → **Create and manage API tokens**
2. Click **Create API token with scopes** (not the plain **Create API token** button)
3. Name it, set expiry to a few months out (not the max), then Next
4. Pick **Bitbucket**, then Next
5. Check the scopes — see [Token scopes by use case](#token-scopes-by-use-case)
6. Create token — copy it now, you won't see it again

### 2. Set the token without putting it in your shell history

```bash
# in ~/.zshrc, ~/.bashrc, or a git-ignored .env you source
export BITBUCKET_API_TOKEN=your-token-here
```

The server reads it from the environment it's launched in, so it never needs to appear on the `claude mcp add` command line or get written into Claude Code's own config file.

### 3. Add it to Claude Code

```bash
claude mcp add --scope user --transport stdio bitbucket -- npx -y bucket-mcp
```

`--scope user` registers it globally across every project rather than just the one you happen to be in. `npx` fetches the published package and runs it, no local clone or build step needed.

### Optional: a default workspace

Most people work in one Bitbucket workspace. Set one and every tool's `workspace` argument becomes optional:

```bash
export BITBUCKET_DEFAULT_WORKSPACE=your-team-slug
```

You can still target a different workspace any time by asking for it explicitly — the AI can call `bitbucket_workspace_list` to discover what else it has access to.

### Optional: permission mode

```bash
export BITBUCKET_MCP_MODE=readonly   # or draft (the default), or readwrite
```

See [Permission modes](#permission-modes) above for what each one allows.

## Development

```bash
git clone git@github.com:Stan15/bucket-mcp.git
cd bucket-mcp
npm install && npm run build
npm test
```

Point the manual setup's step 3 command at `node /absolute/path/to/bucket-mcp/dist/index.js` instead of the `npx` line to run from your local clone.
