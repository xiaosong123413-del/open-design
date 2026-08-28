# ChatGPT Web bridge

`od-chatgpt-web` is the Stage 2 boundary between OpenDesign and a DevSpace-owned ChatGPT Web session. It does not call the OpenAI API and does not automate `chatgpt.com` directly.

## Architecture

```text
OpenDesign / shell
       |
       | prompt + cwd
       v
od-chatgpt-web
       |
       | bundled runner (automatic)
       v
od-devspace-chatgpt-runner
       |
       | MCP Streamable HTTP (preferred)
       | or explicit stdio fallback
       v
DevSpace desktop local bridge
       |
       v
persistent DevSpace run
       |
       v
ChatGPT Web child session + DevSpace tools
       |
       +--> edit files
       +--> run commands
       +--> inspect browser preview
       +--> return completion state
```

The public Devspace product documentation describes a Windows desktop app with a local bridge service and an MCP connection used by ChatGPT. The OpenDesign integration therefore treats the local bridge URL as the primary transport instead of assuming a separate `devspace-mcp` executable exists.

## Build

```bash
pnpm --filter @open-design/daemon build
```

The daemon package exposes:

```bash
pnpm exec od-chatgpt-web --version
pnpm exec od-devspace-chatgpt-runner --version
```

`od-chatgpt-web` automatically launches the bundled `od-devspace-chatgpt-runner`; `OD_CHATGPT_WEB_RUNNER` is only needed when overriding that runner.

## One-time project binding

One persistent DevSpace run must already be bound to the intended project workspace. The MCP endpoint itself is discovered from the running DevSpace desktop backend by default.

The current desktop contract is:

```text
GET http://127.0.0.1:7676/control/status
        |
        +--> mcpUrl
```

The returned `mcpUrl` is the authoritative Streamable HTTP MCP resource. An explicit URL remains available as an override when the desktop control endpoint is relocated.

Project binding can be supplied as environment configuration:

```bash
export OD_DEVSPACE_RUN_ID='<persistent run id>'
```

Optional transport overrides:

```bash
export OD_DEVSPACE_CONTROL_STATUS_URL='http://127.0.0.1:7676/control/status'
export OD_DEVSPACE_MCP_URL='<explicit DevSpace MCP URL>'
```

or directly on one invocation when an explicit MCP URL is required:

```bash
pnpm exec od-chatgpt-web run \
  --cwd /path/to/project \
  --mcp-url '<explicit DevSpace MCP URL>' \
  --devspace-run-id '<persistent run id>' \
  --prompt 'Design a settings page and verify it in the browser preview.'
```

If a DevSpace build explicitly exposes an MCP stdio command instead of a local URL, use the compatibility path:

```bash
pnpm exec od-chatgpt-web run \
  --cwd /path/to/project \
  --mcp-command /path/to/explicit-mcp-server \
  --mcp-arg=--stdio \
  --devspace-run-id '<persistent run id>' \
  --prompt 'Design a dashboard.'
```

## OAuth authentication

The discovered DevSpace MCP resource is OAuth-protected. OpenDesign must not bypass that protection or read DevSpace's owner-password file. The runner accepts `OD_DEVSPACE_ACCESS_TOKEN` only for a bearer token that has already been issued through DevSpace's normal OAuth authorization flow:

```bash
export OD_DEVSPACE_ACCESS_TOKEN='<already-authorized bearer token>'
```

The access token is environment-only. Do not put the DevSpace Owner password, ChatGPT cookies, bearer tokens, or refresh tokens in CLI arguments, project files, or the bridge JSONL protocol.

Interactive OAuth acquisition and secure token persistence are not implemented by this Stage 2 runner yet. Until the product surface owns that flow, a caller must provide an already-authorized bearer token.

## Normal design use

After the project binding and OAuth authorization are stored by the calling OpenDesign surface, normal use should collapse to:

```bash
pnpm exec od-chatgpt-web run \
  --cwd /path/to/project \
  --prompt 'Make the billing page feel more like Linear and verify the preview.'
```

The product UI should own the one-time MCP URL / DevSpace run binding. Users should not be asked for those values on every design prompt.

## What the bundled runner does

For each invocation it:

1. discovers the DevSpace MCP URL from the local desktop control status endpoint unless an explicit URL or stdio transport is configured;
2. connects through Streamable HTTP using an already-authorized bearer token when supplied, or through the explicit stdio fallback;
3. calls `tools/list` and requires `devspace_agent_spawn` plus `devspace_agent_get`;
4. inspects the live `devspace_agent_spawn` input schema before adding optional arguments, avoiding hard-coded optional fields that a different DevSpace build may not support;
5. starts an `implementer` ChatGPT Web child session inside the bound persistent run;
6. polls the child session, streaming new observed replies as bridge `text` events;
7. emits `done` or `error` when DevSpace reaches terminal state.

The request `cwd` is included in the child task for verification and context. It does not silently rebind a DevSpace run to another project.

## Protocol

Protocol identifier:

```text
od-chatgpt-web/1
```

The outer bridge sends one JSON request to the bundled runner and receives newline-delimited JSON events.

Example request:

```json
{"protocol":"od-chatgpt-web/1","type":"run","requestId":"<uuid>","cwd":"/project","prompt":"Design a dashboard","imagePaths":[]}
```

Supported event types are `session`, `status`, `text`, `tool`, `artifact`, `preview`, `done`, and `error`.

## Security boundary

OpenDesign never needs ChatGPT cookies, browser session tokens, or an OpenAI API key for this path. DevSpace remains responsible for ChatGPT session ownership, local permission gates, filesystem access, commands, browser inspection, and OAuth authorization.

The OpenDesign runner may receive an already-issued DevSpace bearer token through its process environment. It does not consume the DevSpace Owner password and must not read DevSpace credential stores directly.

## Validation boundary

The implementation includes focused mocked tests for protocol parsing, bridge behavior, DevSpace transport configuration, and child-state normalization.

Stage 2 is fully proven only when all of the following are true:

```text
TypeScript typecheck passes
        +
focused tests pass
        +
DevSpace desktop exposes a real local MCP endpoint
        +
the endpoint exposes devspace_agent_spawn/devspace_agent_get
        +
a real child ChatGPT Web session modifies the intended workspace
        +
visible UI validation completes when requested
```

GitHub Actions on this fork has not produced a validation run for this PR yet, so CI success must not be claimed until a real run exists.

## Stage boundary

Included in Stage 2:

```text
OpenDesign bridge CLI
bundled DevSpace runner
auditable JSONL protocol
HTTP + stdio MCP transports
live DevSpace tool capability probing
ChatGPT Web child-session spawn/poll loop
```

Not included yet:

```text
Agent Picker entry
native RuntimeAgentDef
automatic DevSpace installation
interactive OAuth authorization/token persistence
automatic DevSpace run creation
browser-login automation
```

The desktop endpoint discovery contract is now implemented against the running DevSpace control-status mechanism. The remaining product-side prerequisites for a no-setup Stage 2 flow are interactive OAuth ownership and creation/persistence of a DevSpace run bound to the exact OpenDesign project workspace.
