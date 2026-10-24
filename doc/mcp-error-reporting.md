# MCP error reporting

`packages/mcp-server` exposes Paperclip REST calls through MCP tools.
The client adds `/api` to the configured API base URL.
Use `/issues` as a request path, rather than `/api/issues`.
The client rejects a repeated prefix before it sends a request.

All failed tool calls return `isError: true`.
HTTP errors include the status, method, path, and a body excerpt.
The excerpt contains at most 512 characters after credential masking.
It supports JSON, HTML, and plain text.
HTML excerpts retain visible text and remove tags, comments, scripts, and styles.
Query values and HTTP headers do not enter the result.
The client masks its configured credential, credential fields, and authentication text.
Successful tool results retain their existing format.

## Consumer boundaries

A source consumer receives this fix after it updates and builds this package.
A consumer that starts `dist/stdio.js` needs a new package build and process restart.
An API image upgrade alone does not update an npm-based MCP process.

An npm consumer of `@paperclipai/mcp-server@latest` uses the upstream package.
This fork does not publish that package when its source merges.
Such a consumer needs one of these release paths:

- Publish a separately named fork package, then change the MCP launcher to that package.
- Submit the fix upstream, wait for npm publication, then restart the MCP process.

Neither release path occurs as part of this source change.
The existing Guild HTTP runtime tools use server routes in the API process.
They do not load `packages/mcp-server`.
This package change does not change those HTTP tool implementations.

## Verification

Run the package test suite explicitly:

```sh
pnpm --filter @paperclipai/mcp-server test
pnpm --filter @paperclipai/mcp-server typecheck
```

The root Vitest configuration and stable test runner also include this package.
Tests cover HTTP 502 HTML, HTTP 404 text, HTTP 409 JSON, and HTTP 200 JSON.
They check typed REST tools, the generic request tool, and both connection tools.
Additional cases check credential masking, excerpt length, repeated prefixes,
and successful text and empty responses.
