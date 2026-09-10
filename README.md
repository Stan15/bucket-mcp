# bucket-mcp

An MCP server for Bitbucket Cloud — code review and PR workflows (repos, pull requests, commits, branches, file browsing, code search, workspace/user discovery) from Claude Code.

## 1. Install

```bash
npm install
npm run build
```

Requires Node 20+.

## 2. Get a Bitbucket API token

1. Bitbucket → your avatar → **Personal settings** → **API tokens** → **Create token**
2. Give it these scopes: `read:repository:bitbucket`, `write:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`, `read:user:bitbucket`, `read:workspace:bitbucket`
3. Copy the token — you won't be able to see it again

Only need read access? Grant just the `read:*` scopes and skip write entirely.

## 3. Set the token without putting it in your shell history

```bash
# in ~/.zshrc, ~/.bashrc, or a git-ignored .env you source
export BITBUCKET_API_TOKEN=your-token-here
```

The server reads it from the environment it's launched in, so it never needs to appear on the `claude mcp add` command line or get written into Claude Code's own config file.

## 4. Add it to Claude Code

```bash
claude mcp add --transport stdio bitbucket -- node /absolute/path/to/bucket-mcp/dist/index.js
```

Use the absolute path to `dist/index.js` from step 1. That's it — restart Claude Code and the tools are available.

## Optional: a default workspace

Most people work in one Bitbucket workspace. Set one and every tool's `workspace` argument becomes optional:

```bash
export BITBUCKET_DEFAULT_WORKSPACE=your-team-slug
```

You can still target a different workspace any time by asking for it explicitly — the AI can call `bitbucket_workspace_list` to discover what else it has access to.

## Optional: read-only mode

```bash
export BITBUCKET_MCP_READONLY=1
```

Removes every write/destructive tool (merge, comment, approve, branch delete, etc.) regardless of what your token can do. Useful if you only ever want to read, or want a second, stricter connection alongside a full-access one.

## Rotating your token

Bitbucket API tokens expire (max 1 year) and can't be edited after creation — only replaced. Update the `BITBUCKET_API_TOKEN` value wherever you set it in step 3, then restart Claude Code — no need to touch the `claude mcp add` registration itself.

## Troubleshooting

- **A tool call fails with "this operation requires scope(s) [...]"** — your token doesn't have that scope. Create a new one with it added (see step 2) and update `BITBUCKET_API_TOKEN`.
- **Tools you expect are missing from the list** — check you didn't set `BITBUCKET_MCP_READONLY=1`, and check your token's scopes.
- **"No workspace specified..." error** — either pass `workspace` explicitly, set `BITBUCKET_DEFAULT_WORKSPACE`, or ask the AI to call `bitbucket_workspace_list` first.
