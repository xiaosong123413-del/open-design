# ChatGPT Web bridge

The experimental `od-chatgpt-web` CLI is the stage-2 integration boundary between OpenDesign and a DevSpace-owned ChatGPT Web session.

It does **not** call the OpenAI API and it does **not** automate `chatgpt.com` directly. OpenDesign talks to one local bridge process; DevSpace remains responsible for browser/session ownership and for adapting ChatGPT Web to the runner protocol below.

## Architecture

```text
OpenDesign / shell
       |
       | prompt + cwd
       v
od-chatgpt-web
       |
       | one JSON request on stdin
       | NDJSON events on stdout
       v
od-devspace-chatgpt-runner
       |
       | MCP stdio
       v
DevSpace persistent run
       |
       v
ChatGPT Web child session + DevSpace tools
       |
       +--> edit files
       +--> run commands
       +--> inspect browser preview
       +--> return completion state
```

This stage intentionally keeps the bridge separate from the OpenDesign Agent Picker. Native picker integration is a later product step.

## Build

From the repository root:

```bash
pnpm --filter @open-design/daemon build
```

The workspace exposes both stage-2 binaries:

```bash
pnpm exec od-chatgpt-web --version
pnpm exec od-devspace-chatgpt-runner --version
```

## One-time DevSpace setup

The bundled runner uses DevSpace's MCP tools `devspace_agent_spawn` and `devspace_agent_get`. It deliberately does not create a DevSpace goal/run on its own because run creation is a user-controlled DevSpace action.

Create or choose one persistent DevSpace run that is already bound to the project workspace, then record its run id. That is the one-time setup for the project. Subsequent design prompts can reuse the same run and spawn a fresh ChatGPT Web implementer session automatically.

The local DevSpace MCP server command must also be available. Configure it as a command plus an argument array; do not put browser cookies or ChatGPT credentials in these values.

```bash
export OD_DEVSPACE_MCP_COMMAND=/path/to/devspace-mcp
export OD_DEVSPACE_MCP_ARGS='["--stdio"]'
export OD_DEVSPACE_RUN_ID='<existing-run-id>'
```

Optional timing controls:

```bash
export OD_DEVSPACE_POLL_MS=2000
export OD_DEVSPACE_TIMEOUT_MS=1800000
```

The runner verifies that the connected MCP server exposes `devspace_agent_spawn` and `devspace_agent_get` before starting a design task.

## Configure OpenDesign to use the bundled DevSpace runner

After building the daemon package, point the outer bridge at the bundled runner:

```bash
export OD_CHATGPT_WEB_RUNNER="$(pwd)/apps/daemon/bin/od-devspace-chatgpt-runner.mjs"
export OD_CHATGPT_WEB_RUNNER_ARGS='[]'
```

Check the outer bridge before running a design task:

```bash
pnpm exec od-chatgpt-web doctor
pnpm exec od-chatgpt-web doctor --json
```

## Run a design task

Prompt as an argument:

```bash
pnpm exec od-chatgpt-web run \
  --cwd /path/to/project \
  --prompt "Design a settings page and verify it in the browser preview."
```

Prompt through stdin, which is the preferred form for long agent prompts:

```bash
cat prompt.md | pnpm exec od-chatgpt-web run --cwd /path/to/project
```

Images can be attached as project-local or absolute paths:

```bash
pnpm exec od-chatgpt-web run \
  --cwd /path/to/project \
  --image ./reference.png \
  --prompt "Match this reference while preserving the existing design system."
```

For each invocation the bundled runner:

1. connects to the configured DevSpace MCP server over stdio;
2. checks for the required DevSpace child-session tools;
3. spawns one `implementer` child session inside the configured persistent run with `workspaceMode: shared`;
4. asks the child to implement the requested change, run relevant validation, and inspect visible UI in a real browser preview when practical;
5. polls the child session and streams new observed replies back as bridge `text` events;
6. emits `done` or `error` when DevSpace reports terminal state.

The persistent run must be bound to the intended project. The request `cwd` is included in the child task for verification and context; it does not silently rebind the DevSpace run to another repository.

## Runner protocol

Protocol identifier:

```text
od-chatgpt-web/1
```

The bridge starts the configured runner without a shell, sets its working directory to the requested project directory, and writes exactly one JSON line to runner stdin.

Example request:

```json
{"protocol":"od-chatgpt-web/1","type":"run","requestId":"<uuid>","cwd":"/project","prompt":"Design a dashboard","imagePaths":[]}
```

The runner writes newline-delimited JSON events to stdout. Every event must contain the same `protocol` and `requestId`.

Supported event types are:

- `session` — a ChatGPT/DevSpace child session was acquired.
- `status` — progress information.
- `text` — the latest observed child-session reply changed.
- `tool` — a runner may surface a DevSpace tool start/result.
- `artifact` — a runner may surface a project file create/update/delete.
- `preview` — a runner may surface a browser preview URL.
- `done` — successful terminal event.
- `error` — failed terminal event.

Example event stream:

```jsonl
{"protocol":"od-chatgpt-web/1","type":"status","requestId":"<uuid>","message":"Connecting to DevSpace MCP"}
{"protocol":"od-chatgpt-web/1","type":"session","requestId":"<uuid>","sessionId":"agent-1"}
{"protocol":"od-chatgpt-web/1","type":"text","requestId":"<uuid>","text":"Implemented the settings page and checked the preview."}
{"protocol":"od-chatgpt-web/1","type":"done","requestId":"<uuid>","summary":"Settings page updated and validated."}
```

The runner may write diagnostics to stderr. The bridge forwards them to its own stderr and never mixes them into the NDJSON stdout stream.

A runner must emit a terminal `done` or `error` event before exiting. Exiting without a terminal event is treated as a bridge failure.

## Security boundary

The bridge intentionally avoids shell command strings. It spawns only the configured runner executable plus explicit argument-array entries. The bundled runner similarly uses MCP stdio with an explicit command/argument array. DevSpace remains the authority for filesystem, command, browser, authentication, permission, and ChatGPT Web session controls.

Do not put ChatGPT cookies, browser session tokens, or OpenAI credentials into bridge arguments or project files. The runner obtains authorized session behavior from DevSpace rather than reimplementing browser authentication.

## Stage boundary

What this stage now provides:

```text
OpenDesign-compatible process boundary
        +
version / doctor / run CLI
        +
structured request-event protocol
        +
bundled DevSpace MCP runner
        +
ChatGPT Web child-session spawn/poll loop
```

What it intentionally does not provide yet:

```text
Agent Picker entry
native OpenDesign runtime definition
automatic DevSpace installation/configuration
automatic DevSpace run creation
browser-login automation
```

Those belong to the native-product integration stage or to DevSpace product setup. Stage 2 is complete only after the focused typecheck/tests pass and one real configured DevSpace run completes an end-to-end design task in the intended workspace.
