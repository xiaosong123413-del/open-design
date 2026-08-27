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
DevSpace-side runner
       |
       v
ChatGPT Web + DevSpace tools
       |
       +--> edit files
       +--> run commands
       +--> inspect browser preview
       +--> return structured events
```

This stage intentionally keeps the bridge separate from the OpenDesign Agent Picker. Native picker integration is a later product step.

## Build

From the repository root:

```bash
pnpm --filter @open-design/daemon build
```

The workspace exposes the binary as:

```bash
pnpm exec od-chatgpt-web --version
```

## Configure the DevSpace-side runner

Point the bridge at an executable that owns the DevSpace/ChatGPT Web interaction:

```bash
export OD_CHATGPT_WEB_RUNNER=/path/to/devspace-chatgpt-web-runner
export OD_CHATGPT_WEB_RUNNER_ARGS='[]'
```

`OD_CHATGPT_WEB_RUNNER_ARGS` is optional and must be a JSON array of strings.

Check the boundary before running a design task:

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

- `session` — a ChatGPT/DevSpace session was acquired.
- `status` — progress information.
- `text` — assistant text output.
- `tool` — a DevSpace tool started or returned a result.
- `artifact` — a project file was created, updated, or deleted.
- `preview` — a browser preview URL is available.
- `done` — successful terminal event.
- `error` — failed terminal event.

Example event stream:

```jsonl
{"protocol":"od-chatgpt-web/1","type":"session","requestId":"<uuid>","sessionId":"chat-session-1"}
{"protocol":"od-chatgpt-web/1","type":"status","requestId":"<uuid>","message":"Opening project"}
{"protocol":"od-chatgpt-web/1","type":"tool","requestId":"<uuid>","name":"edit","phase":"start"}
{"protocol":"od-chatgpt-web/1","type":"artifact","requestId":"<uuid>","path":"src/App.tsx","action":"updated"}
{"protocol":"od-chatgpt-web/1","type":"preview","requestId":"<uuid>","url":"http://localhost:5173"}
{"protocol":"od-chatgpt-web/1","type":"done","requestId":"<uuid>","summary":"Dashboard updated and preview verified."}
```

The runner may write diagnostics to stderr. The bridge forwards them to its own stderr and never mixes them into the NDJSON stdout stream.

A runner must emit exactly one terminal `done` or `error` event before exiting. Exiting without a terminal event is treated as a bridge failure.

## Security boundary

The bridge intentionally avoids shell command strings. It spawns only the configured runner executable plus explicit argument-array entries. DevSpace remains the authority for filesystem, command, browser, authentication, permission, and ChatGPT Web session controls.

Do not put ChatGPT cookies, browser session tokens, or OpenAI credentials into bridge arguments or project files. The runner should obtain authorized session state from DevSpace rather than reimplementing browser authentication.

## Stage boundary

What this stage provides:

```text
OpenDesign-compatible process boundary
        +
version / doctor / run CLI
        +
structured request-event protocol
        +
DevSpace runner slot
```

What it intentionally does not provide yet:

```text
Agent Picker entry
native OpenDesign runtime definition
automatic DevSpace installation/configuration
browser-login automation
```

Those belong to the native-product integration stage after the bridge contract has been proven with a real DevSpace runner.
