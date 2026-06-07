---
name: kesefle-deferred-tool-load
description: Load a deferred MCP/tool schema via ToolSearch (select:NAME or keyword search) BEFORE calling it, so a Kesefle automation never hits InputValidationError from an unloaded tool; bulk-load a toolkit by server keyword.
---

# Load a deferred tool before calling it

In this environment most MCP tools are **deferred**: a system-reminder lists their NAMES, but their parameter schemas are not loaded, so calling one directly fails with `InputValidationError`. You must fetch the schema with `ToolSearch` first; only after its `<function>` definition appears is the tool callable. This is the recurring trip-up when a Kesefle skill reaches for Vercel, Google Drive, Monday, or the Workflow tools mid-task.

## Steps
1. Notice the signal: the tool you want is listed by NAME in a `<system-reminder>` (deferred), not defined at the top of the prompt. Do not call it yet.
2. Load by exact name (fastest when you know it):
   `ToolSearch` with `query: "select:list_projects"` - or several at once: `query: "select:list_projects,get_runtime_logs,get_deployment"`.
3. Or keyword-search when you only know the capability: `query: "vercel deployment logs"` (ranked matches), or scope to one server with a `+` term: `query: "+vercel logs"`.
4. Confirm the result contains a `<function>{"name":"...","parameters":{...}}</function>` block for your tool. That block IS the loaded schema - the tool is now invocable exactly like a top-level tool.
5. Call the tool with arguments that match the just-returned schema.

## Bulk-load a whole toolkit
- Kesefle MCP servers are addressed by an opaque server-id prefix (e.g. the Vercel server's tools are `mcp__<id>__list_projects`, `..._get_runtime_logs`, `..._list_deployments`). To pull the set, search by capability + server keyword (`"+vercel deploy logs projects"`) or `select:` several names you saw in the reminder in one call, rather than one round-trip per tool.
- Typical Kesefle clusters worth bulk-loading: Vercel (env audit, prod log triage), Google Drive (live-sheet read), Monday (end-of-task task sync), Workflow/agent-orchestration (autonomous block runner).

## Worked example (Vercel env audit start)
1. The reminder lists `mcp__<id>__list_projects` and `mcp__<id>__get_runtime_logs` as deferred.
2. `ToolSearch` -> `query: "+vercel projects runtime logs deployments"` (or `select:` the exact names if you copied them from the reminder).
3. The result returns `<function>` blocks for each - now `list_projects` is callable.
4. Call `list_projects`, find `kesefle`, then inspect env var NAMES ([[kesefle-vercel-env-audit]]) - never values.

## Verification
- After `ToolSearch`, the response body contains a `<function>` entry whose `"name"` equals the tool you intend to call.
- The subsequent tool call returns a normal result, NOT `InputValidationError` / "tool not found".
- For a bulk load, every name you intend to call appears as its own `<function>` block in the search result before you start calling them.

## Common pitfalls
- Calling a deferred tool straight from the system-reminder name - guaranteed `InputValidationError`; the name alone has no schema.
- Guessing a tool name from training data - only `select:` names that actually appear in the reminder, or keyword-search and use what comes back.
- Loading one tool when the task needs three (e.g. `list_projects` + `get_deployment` + `get_runtime_logs` for [[kesefle-vercel-env-audit]] / prod debugging) - `select:` them together up front.
- Re-loading every turn - once a schema is in context for the session it stays callable; only re-search if you genuinely need a new tool.
- Forgetting which Kesefle skills depend on this: [[kesefle-vercel-env-audit]], [[kesefle-autonomous-block-runner]], and any live-sheet read all begin with a ToolSearch load.
- Treating a keyword search as exhaustive - if the expected tool name doesn't come back, widen the query or `select:` the exact name from the reminder; ranking can bury a match below `max_results`.
- Assuming the same opaque server-id prefix across sessions - the `mcp__<id>__` prefix can change, so match on the tool's suffix name, not a memorized full id.
