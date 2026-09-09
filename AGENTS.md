# oagent

MCP server that exposes OpenCode to Claude Code as a subagent via ACP, with a React SPA for live job observability.

## Stack

- Bun, TypeScript, Effect.ts
- @modelcontextprotocol/sdk — MCP server implementation
- @agentclientprotocol/sdk — direct ACP session over opencode subprocess
- @orpc/server + ff-effect/for/orpc — typed RPC with Effect-native handlers
- React 19 + Vite + Tailwind v4 — web SPA, embedded into the binary at build time

## Workspace

- `apps/cli` (`@oagent/cli`) — thin binary entry point.
- `apps/web` (`@oagent/web`) — Vite + React SPA; type-imports `EngineRouter` from `@oagent/engine`.
- `services/engine` (`@oagent/engine`) — Effect services (`Jobs`, `OpenCode`), HTTP handlers, oRPC router.
- `packages/common` (`@oagent/common`) — shared dev utilities (DevSessions).

## Dev

Quick commands:

```sh
pnpm dev       # parallel: engine + vite; engine picks port and DB session, web polls for engine URL
pnpm check     # typecheck + biome across all packages
pnpm run build # produce standalone binary at apps/cli/dist/oagent
```

For details see:
- [Engine dev](services/engine/docs/development.md) — sessions, sticky port, env vars
- [Web dev](apps/web/docs/development.md) — Vite proxy, `ENGINE_URL`

## Architecture

- `apps/cli/src/index.ts` — Effect CLI with `serve`, `service`, `stdio`, `jobs`, `doctor`, and `claude mcp serve` subcommands. `serve` loads the embedded SPA filemap from `.gen/web-ui.gen.ts` and delegates to engine's `createServer`; `--log-file <path>` swaps the default pretty console logger for a JSONL file logger. `service start|restart|status|stop` manages the macOS-only launchd LaunchAgent (`com.oagent.service`) that runs the compiled `oagent serve --port <n> --log-file ~/.config/oagent/logs/oagent.jsonl` in the background. `stdio` registers MCP tools over the stdio transport via `registerTools`. Only the commands that need the in-process engine provide `Engine.layer`; the CLI root provides only `BunContext`, deliberately, so `claude mcp serve` (which does NOT need it) never opens the DB and runs orphan-recovery against a live engine's jobs.
- `apps/cli/src/commands/service.ts` — launchd-backed background service management for macOS. Writes `~/Library/LaunchAgents/com.oagent.service.plist`, loads/unloads it with `launchctl bootstrap|bootout gui/<uid>`, and logs to `~/.config/oagent/logs/oagent.jsonl` plus launchd stdout/stderr files `oagent.out.log` and `oagent.err.log`. Refuses to install from `bun`; requires the built `oagent` binary. `start` is idempotent — no-ops if already loaded. `restart` boots out, writes a fresh plist, and bootstraps (picks up a rebuilt binary, new PATH, or new port). `stop` boots out and removes the plist (full uninstall — the service will not relaunch on next login).
- `apps/cli/src/commands/claude.ts` + `apps/cli/src/lib/channel.ts` — `oagent claude mcp serve` runs a dedicated [Claude Code channel](https://code.claude.com/docs/en/channels-reference) MCP over stdio. Unlike `stdio`, it does NOT run jobs in-process: it's a thin oRPC client (`@orpc/client`) bridging to a running engine (`--engine-url`, default `http://localhost:17777` or `$OPENCODE_MCP_PORT`). `start` forks the job and returns `{jobId}` immediately; a fire-and-forget waiter listens on the engine's SSE event stream (`/jobs/:id/events`) until the `__terminal__` sentinel, then fetches the final result once via `jobs.wait` and pushes it into the session as a `notifications/claude/channel` event (`<channel source="oagent" job_id status session_id>…`) — no polling/background-curl needed. The server declares `capabilities.experimental['claude/channel']`; `result`/`cancel` stay as a fallback. Enable with `claude --dangerously-load-development-channels server:<configKey>` during the research preview.
- `services/engine/src/server.ts` — the actual HTTP dispatcher. `createServer({ port, serverInfo, filemap? })` builds the Bun.serve fetch handler and binds it. Routes, in order: `/mcp` → MCP transport (WebStandard streamable), `/rpc/*` → engine oRPC handler, `/jobs/:id/events` → raw SSE, `/jobs/:id/wait` → long-poll JSON. SPA fallback only fires when `filemap` is provided; otherwise returns 404. Defaults to port 17777 (overridable via `--port` or `OPENCODE_MCP_PORT`); falls back to port 0 on EADDRINUSE. Startup notifications now go through the Effect logger, so foreground `serve` prints prettily and `serve --log-file` captures the same events as JSONL.
- `services/engine/src/cli.ts` — dev-only `@effect/cli` entrypoint for the engine. Exposes a single `serve` subcommand that calls `createServer` without a filemap. Used by `services/engine/scripts/dev.ts`.
- `apps/cli/scripts/build.ts` — runs `vite build` in `apps/web`, walks `apps/web/dist/`, generates `apps/cli/.gen/web-ui.gen.ts` with `import ... with { type: 'file' }` plus a default-export filemap, then `Bun.build({ compile: true })` listing both entrypoints so assets embed into the standalone binary.
- `services/engine/src/db/schema.ts` — Drizzle SQLite schema. `jobs` table with UUIDv7 public ids + internal autoincrement PK; `events` polymorphic base with per-variant tables (`chunk_events`, `tool_call_events`, `plan_events`, etc.). All 11 `SessionUpdate` variants modeled. Opaque nested fields stay JSON; structured fields are decomposed. Property names are snake_case so they map verbatim to SQL.
- `services/engine/src/db/client.ts` — `Db` Effect service with `scoped` lifecycle. Opens `~/.config/oagent/sqlite.db` with WAL + foreign_keys + busy_timeout pragmas. Runs embedded migrations and orphan recovery (`UPDATE jobs SET status='error' WHERE status='running'`) on acquire.
- `services/engine/src/config.ts` — Effect-based JSON config loader. Reads `~/.config/oagent/config.json` (or `OAGENT_CONFIG_PATH` override), validates via Effect Schema, and returns decoded values. Missing file is normal and yields defaults; malformed files surface as errors. Currently exposes the `portless` boolean.
- `services/engine/src/db/migrate.ts` — Embedded migration runner. Reuses Drizzle's internal `dialect.migrate(...)` by constructing `MigrationMeta[]` from `with { type: 'text' }` imported SQL files (codegenned by `scripts/gen-migrations.ts`). Keeps parity with `drizzle-kit migrate` dev workflow.
- `services/engine/src/jobs.ts` — `Jobs` Effect service. `Jobs.start` forks `OpenCode.runTurn` into a daemon fiber and returns a `jobId`; events are written to SQLite in a transaction (base `events` row + variant table). `Jobs.wait` blocks up to a timeout and returns `running | done | error`. Live SSE fanout uses an in-memory `EventEmitter` keyed by job id; history is read from DB. Jobs persist indefinitely; no sweep. Does not know about MCP or HTTP.
- `services/engine/src/opencode.ts` — `OpenCode` Effect service wrapping the opencode ACP subprocess session.
- `services/engine/src/http/{sse,wait,spa}.ts` — HTTP response builders. SSE reads history from DB then attaches to the live `EventEmitter` (buffer-then-drain to close the read-then-attach race). Sends `__terminal__` sentinel when the job finishes. Wait blocks via `Jobs.wait` and returns the terminal result as JSON. SPA serves files from the embedded filemap with index.html fallback for client routing.
- `services/engine/src/rpc/router.ts` — oRPC router built via `createHandler` from `ff-effect/for/orpc`. Procedures: `jobs.list`, `jobs.get`, `jobs.start`, `jobs.wait`. Output schemas declared explicitly via Valibot — required workaround: without `.output(...)` the inferred output type collapses to `unknown` (conditional union of generic `runEffect` functions defeats TS inference). Exports `type EngineRouter = Effect.Effect.Success<typeof program>` for client-side inference.
- `apps/web/src/lib/orpc.ts` — typed oRPC client over `RPCLink` to `/rpc`. In dev Vite proxies to `ENGINE_URL`; in prod served same-origin from the embedded SPA (or `?engine=` query to override).
