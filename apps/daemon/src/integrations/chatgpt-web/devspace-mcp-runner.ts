import { resolve } from 'node:path';
import { stdin as processStdin, stderr as processStderr, stdout as processStdout } from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CHATGPT_WEB_BRIDGE_PROTOCOL,
  type ChatGptWebRunRequest,
  type ChatGptWebBridgeEvent,
} from './protocol.js';

const RUNNER_VERSION = '0.3.0';
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CONTROL_STATUS_URL = 'http://127.0.0.1:7676/control/status';

type JsonRecord = Record<string, unknown>;

interface RunnerIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

type DevSpaceMcpTransportConfig =
  | { kind: 'http'; url: string; accessToken?: string }
  | { kind: 'discover'; controlStatusUrl: string; accessToken?: string }
  | { kind: 'stdio'; command: string; args: string[] };

export interface DevSpaceMcpRunnerConfig {
  transport: DevSpaceMcpTransportConfig;
  runId: string;
  pollMs: number;
  timeoutMs: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonArray(value: string | undefined, name: string): string[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${name} must be a JSON string array: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} must be a JSON string array.`);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function validateHttpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid http(s) URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https.`);
  }
  return url.toString();
}

export async function discoverDevSpaceMcpUrl(
  controlStatusUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchFn(controlStatusUrl, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `DevSpace control status discovery failed with HTTP ${response.status} at ${controlStatusUrl}.`,
    );
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.mcpUrl !== 'string' || !body.mcpUrl.trim()) {
    throw new Error('DevSpace control status did not provide a non-empty mcpUrl.');
  }
  return validateHttpUrl(body.mcpUrl.trim(), 'DevSpace control status mcpUrl');
}

export function resolveDevSpaceMcpRunnerConfig(
  env: NodeJS.ProcessEnv = process.env,
): DevSpaceMcpRunnerConfig {
  const mcpUrl = env.OD_DEVSPACE_MCP_URL?.trim();
  const command = env.OD_DEVSPACE_MCP_COMMAND?.trim();
  const accessToken = env.OD_DEVSPACE_ACCESS_TOKEN?.trim() || undefined;
  if (mcpUrl && command) {
    throw new Error('Configure only one DevSpace MCP transport: OD_DEVSPACE_MCP_URL or OD_DEVSPACE_MCP_COMMAND.');
  }

  const runId = env.OD_DEVSPACE_RUN_ID?.trim();
  if (!runId) {
    throw new Error(
      'OD_DEVSPACE_RUN_ID is not configured. Bind this OpenDesign project to one persistent DevSpace run first; the run id is project binding state, not a per-prompt value.',
    );
  }

  const transport: DevSpaceMcpTransportConfig = mcpUrl
    ? { kind: 'http', url: validateHttpUrl(mcpUrl, 'OD_DEVSPACE_MCP_URL'), ...(accessToken ? { accessToken } : {}) }
    : command
      ? {
          kind: 'stdio',
          command,
          args: parseJsonArray(env.OD_DEVSPACE_MCP_ARGS, 'OD_DEVSPACE_MCP_ARGS'),
        }
      : {
          kind: 'discover',
          controlStatusUrl: validateHttpUrl(
            env.OD_DEVSPACE_CONTROL_STATUS_URL?.trim() || DEFAULT_CONTROL_STATUS_URL,
            'OD_DEVSPACE_CONTROL_STATUS_URL',
          ),
          ...(accessToken ? { accessToken } : {}),
        };

  return {
    transport,
    runId,
    pollMs: parsePositiveInteger(env.OD_DEVSPACE_POLL_MS, DEFAULT_POLL_MS, 'OD_DEVSPACE_POLL_MS'),
    timeoutMs: parsePositiveInteger(
      env.OD_DEVSPACE_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      'OD_DEVSPACE_TIMEOUT_MS',
    ),
  };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseBridgeRequest(raw: string): ChatGptWebRunRequest {
  const line = raw.trim();
  if (!line) throw new Error('DevSpace runner received an empty request.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `DevSpace runner received invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error('DevSpace runner request must be a JSON object.');
  if (parsed.protocol !== CHATGPT_WEB_BRIDGE_PROTOCOL) {
    throw new Error(`Unsupported bridge protocol: ${String(parsed.protocol ?? '<missing>')}`);
  }
  if (parsed.type !== 'run') throw new Error('DevSpace runner only accepts run requests.');
  if (typeof parsed.requestId !== 'string' || !parsed.requestId) {
    throw new Error('DevSpace runner request is missing requestId.');
  }
  if (typeof parsed.cwd !== 'string' || !parsed.cwd) {
    throw new Error('DevSpace runner request is missing cwd.');
  }
  if (typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) {
    throw new Error('DevSpace runner request is missing prompt.');
  }
  if (!Array.isArray(parsed.imagePaths) || parsed.imagePaths.some((item) => typeof item !== 'string')) {
    throw new Error('DevSpace runner request imagePaths must be a string array.');
  }
  return parsed as unknown as ChatGptWebRunRequest;
}

function parseTextContent(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.structuredContent !== undefined) return value.structuredContent;
  if (!Array.isArray(value.content)) return value;

  const texts = value.content
    .filter((item): item is JsonRecord => isRecord(item) && item.type === 'text')
    .map((item) => item.text)
    .filter((text): text is string => typeof text === 'string');
  if (texts.length === 0) return value;

  const joined = texts.join('\n').trim();
  try {
    return JSON.parse(joined);
  } catch {
    return { text: joined };
  }
}

export function findStringByKeys(value: unknown, keys: readonly string[]): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKeys(item, keys);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  for (const child of Object.values(value)) {
    const found = findStringByKeys(child, keys);
    if (found) return found;
  }
  return null;
}

export function classifyAgentState(value: unknown): 'working' | 'completed' | 'failed' | 'waiting' {
  const normalized = parseTextContent(value);
  const status = findStringByKeys(normalized, [
    'status',
    'state',
    'taskStatus',
    'task_status',
    'reviewState',
    'review_state',
  ])?.toLowerCase();

  if (status && ['completed', 'complete', 'succeeded', 'success', 'approved'].includes(status)) {
    return 'completed';
  }
  if (status && ['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(status)) {
    return 'failed';
  }
  if (status && ['waiting', 'needs_input', 'blocked', 'paused'].includes(status)) {
    return 'waiting';
  }
  if (isRecord(normalized) && normalized.result !== undefined && normalized.result !== null) {
    return 'completed';
  }
  return 'working';
}

function emit(io: RunnerIo, event: ChatGptWebBridgeEvent): void {
  io.stdout.write(`${JSON.stringify(event)}\n`);
}

function taskText(request: ChatGptWebRunRequest): string {
  const images = request.imagePaths.length > 0
    ? `\nReference image paths:\n${request.imagePaths.map((path) => `- ${path}`).join('\n')}`
    : '';
  return [
    'Execute this OpenDesign task in the DevSpace-bound project workspace.',
    `Requested project cwd: ${resolve(request.cwd)}`,
    '',
    request.prompt,
    images,
    '',
    'Requirements:',
    '- Make the requested changes in the project; do not only describe them.',
    '- Use the project instructions and existing design system/components when present.',
    '- Run the cheapest relevant build, typecheck, or focused test when practical.',
    '- For visible UI changes, inspect the actual running preview in the browser when practical.',
    '- Finish with a concise summary of changed files and validation performed.',
  ].filter(Boolean).join('\n');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function callTool(client: Client, name: string, args: JsonRecord): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  if (isRecord(result) && result.isError === true) {
    const parsed = parseTextContent(result);
    const message = findStringByKeys(parsed, ['message', 'error', 'text']) ?? `DevSpace tool ${name} failed.`;
    throw new Error(message);
  }
  return parseTextContent(result);
}

function toolAcceptsProperty(tool: { inputSchema?: unknown }, property: string): boolean {
  if (!isRecord(tool.inputSchema)) return false;
  const properties = tool.inputSchema.properties;
  return isRecord(properties) && Object.prototype.hasOwnProperty.call(properties, property);
}

function buildSpawnArgs(
  runId: string,
  task: string,
  spawnTool: { inputSchema?: unknown },
): JsonRecord {
  const args: JsonRecord = { runId, role: 'implementer', task };
  if (toolAcceptsProperty(spawnTool, 'name')) args.name = 'OpenDesign ChatGPT Web';
  if (toolAcceptsProperty(spawnTool, 'acceptanceCriteria')) {
    args.acceptanceCriteria = [
      'Implement the requested design or application change in the bound project workspace.',
      'Run relevant validation when practical and report failures instead of hiding them.',
      'Inspect visible UI changes in a real browser preview when practical.',
    ];
  }
  if (toolAcceptsProperty(spawnTool, 'workspaceMode')) args.workspaceMode = 'shared';
  return args;
}

async function resolveTransportConfig(
  config: DevSpaceMcpTransportConfig,
): Promise<Exclude<DevSpaceMcpTransportConfig, { kind: 'discover' }>> {
  if (config.kind !== 'discover') return config;
  const url = await discoverDevSpaceMcpUrl(config.controlStatusUrl);
  return {
    kind: 'http',
    url,
    ...(config.accessToken ? { accessToken: config.accessToken } : {}),
  };
}

function createTransport(config: Exclude<DevSpaceMcpTransportConfig, { kind: 'discover' }>) {
  if (config.kind === 'http') {
    return new StreamableHTTPClientTransport(
      new URL(config.url),
      config.accessToken
        ? { requestInit: { headers: { authorization: `Bearer ${config.accessToken}` } } }
        : undefined,
    );
  }
  return new StdioClientTransport({ command: config.command, args: config.args });
}

function isMcpTransport(value: unknown): value is Transport {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof Reflect.get(value, 'start') === 'function' &&
    typeof Reflect.get(value, 'send') === 'function' &&
    typeof Reflect.get(value, 'close') === 'function'
  );
}

export async function runDevSpaceMcpRunner(
  request: ChatGptWebRunRequest,
  config: DevSpaceMcpRunnerConfig,
  io: RunnerIo,
): Promise<void> {
  const client = new Client({ name: 'open-design-chatgpt-web-runner', version: RUNNER_VERSION });
  const transportConfig = await resolveTransportConfig(config.transport);
  const transport = createTransport(transportConfig);

  try {
    if (config.transport.kind === 'discover') {
      emit(io, {
        protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
        type: 'status',
        requestId: request.requestId,
        message: `Discovered DevSpace MCP endpoint ${transportConfig.kind === 'http' ? transportConfig.url : '<unknown>'}`,
      });
    }
    emit(io, {
      protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
      type: 'status',
      requestId: request.requestId,
      message: `Connecting to DevSpace MCP via ${transportConfig.kind}`,
    });
    if (!isMcpTransport(transport)) {
      throw new Error('Resolved DevSpace MCP transport does not implement the MCP transport contract.');
    }
    await client.connect(transport);

    const listed = await client.listTools();
    const spawnTool = listed.tools.find((tool) => tool.name === 'devspace_agent_spawn');
    const getTool = listed.tools.find((tool) => tool.name === 'devspace_agent_get');
    if (!spawnTool || !getTool) {
      throw new Error(
        'Connected MCP server is not the DevSpace bridge: required tools devspace_agent_spawn/devspace_agent_get were not both exposed.',
      );
    }

    emit(io, {
      protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
      type: 'status',
      requestId: request.requestId,
      message: 'Starting ChatGPT Web design session',
    });

    const spawnResult = await callTool(
      client,
      'devspace_agent_spawn',
      buildSpawnArgs(config.runId, taskText(request), spawnTool),
    );

    const agentId = findStringByKeys(spawnResult, ['agentId', 'agent_id', 'id']);
    if (!agentId) throw new Error('DevSpace did not return an agentId from devspace_agent_spawn.');

    emit(io, {
      protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
      type: 'session',
      requestId: request.requestId,
      sessionId: agentId,
    });

    let lastReply = '';
    const startedAt = Date.now();
    while (true) {
      if (Date.now() - startedAt > config.timeoutMs) {
        throw new Error(`DevSpace agent timed out after ${config.timeoutMs} ms.`);
      }

      const agent = await callTool(client, 'devspace_agent_get', { agentId });
      const reply = findStringByKeys(agent, [
        'latestObservedReply',
        'latest_observed_reply',
        'latestReply',
        'latest_reply',
      ]);
      if (reply && reply !== lastReply) {
        lastReply = reply;
        emit(io, {
          protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
          type: 'text',
          requestId: request.requestId,
          text: reply,
        });
      }

      const state = classifyAgentState(agent);
      if (state === 'completed') {
        const reportedSummary = findStringByKeys(agent, [
          'summary',
          'resultSummary',
          'result_summary',
          'message',
        ]);
        emit(io, {
          protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
          type: 'done',
          requestId: request.requestId,
          summary: reportedSummary ?? (lastReply || 'DevSpace ChatGPT Web task completed.'),
        });
        return;
      }
      if (state === 'failed') {
        emit(io, {
          protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
          type: 'error',
          requestId: request.requestId,
          code: 'DEVSPACE_AGENT_FAILED',
          message:
            findStringByKeys(agent, ['error', 'message', 'summary']) ??
            'DevSpace ChatGPT Web task failed.',
          recoverable: false,
        });
        return;
      }
      if (state === 'waiting') {
        emit(io, {
          protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
          type: 'status',
          requestId: request.requestId,
          message: 'DevSpace agent is waiting for input or approval',
        });
      }

      await sleep(config.pollMs);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

function usage(): string {
  return `od-devspace-chatgpt-runner ${RUNNER_VERSION}\n\nReads one od-chatgpt-web/1 run request from stdin and executes it through an existing DevSpace run.\n\nEnvironment:\n  OD_DEVSPACE_MCP_URL              Optional explicit DevSpace MCP URL.\n  OD_DEVSPACE_CONTROL_STATUS_URL   Optional discovery endpoint; default ${DEFAULT_CONTROL_STATUS_URL}.\n  OD_DEVSPACE_ACCESS_TOKEN         Optional bearer token for an already-authorized DevSpace OAuth client.\n  OD_DEVSPACE_MCP_COMMAND          Fallback: explicit stdio MCP server command.\n  OD_DEVSPACE_MCP_ARGS             Optional JSON array for the stdio command.\n  OD_DEVSPACE_RUN_ID               Persistent DevSpace run bound to this OpenDesign project.\n  OD_DEVSPACE_POLL_MS              Optional poll interval; default ${DEFAULT_POLL_MS}.\n  OD_DEVSPACE_TIMEOUT_MS           Optional timeout; default ${DEFAULT_TIMEOUT_MS}.\n`;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  io: RunnerIo = { stdin: processStdin, stdout: processStdout, stderr: processStderr },
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(usage());
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-V')) {
    io.stdout.write(`od-devspace-chatgpt-runner ${RUNNER_VERSION}\n`);
    return 0;
  }
  if (argv.length > 0) {
    io.stderr.write(`Unknown arguments: ${argv.join(' ')}\n`);
    return 1;
  }

  let request: ChatGptWebRunRequest | null = null;
  try {
    request = parseBridgeRequest(await readStream(io.stdin));
    const config = resolveDevSpaceMcpRunnerConfig();
    await runDevSpaceMcpRunner(request, config, io);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request) {
      emit(io, {
        protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
        type: 'error',
        requestId: request.requestId,
        code: 'DEVSPACE_RUNNER_ERROR',
        message,
        recoverable: false,
      });
    } else {
      io.stderr.write(`${message}\n`);
    }
    return 1;
  }
}
