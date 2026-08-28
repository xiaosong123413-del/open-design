import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as processStdin, stderr as processStderr, stdout as processStdout } from 'node:process';
import {
  doctorChatGptWebBridge,
  resolveChatGptWebRunnerConfig,
  runChatGptWebBridge,
  type ChatGptWebRunnerConfig,
} from './bridge.js';
import { CHATGPT_WEB_BRIDGE_PROTOCOL } from './protocol.js';

const BRIDGE_CLI_VERSION = '0.2.0';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DEVSPACE_RUNNER = resolve(MODULE_DIR, '../../../bin/od-devspace-chatgpt-runner.mjs');

interface CliInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
}

interface CliIo {
  stdin: CliInput;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

interface ParsedRunArgs {
  cwd: string;
  prompt?: string;
  promptFile?: string;
  imagePaths: string[];
  runner?: string;
  runnerArgs: string[];
  mcpUrl?: string;
  mcpCommand?: string;
  mcpArgs: string[];
  devspaceRunId?: string;
}

function usage(): string {
  return `od-chatgpt-web ${BRIDGE_CLI_VERSION}

Bridge OpenDesign to a DevSpace-owned ChatGPT Web runner without using the OpenAI API.

Usage:
  od-chatgpt-web doctor [--json]
  od-chatgpt-web run [options]
  od-chatgpt-web --version

Run options:
  --cwd <path>              Project working directory. Defaults to the current directory.
  --prompt <text>           Prompt text. If omitted, prompt is read from stdin.
  --prompt-file <path|->    Read the prompt from a file or stdin when path is '-'.
  --image <path>            Attach an image path. May be repeated.
  --mcp-url <url>           DevSpace desktop local MCP bridge URL.
  --devspace-run-id <id>    Persistent DevSpace run bound to this project.
  --mcp-command <path>      Fallback stdio MCP server command.
  --mcp-arg <arg>           Add one stdio MCP server argument. May be repeated.
  --runner <path>           Override the bundled DevSpace runner.
  --runner-arg <arg>        Add a runner argument. May be repeated.

Environment equivalents:
  OD_DEVSPACE_MCP_URL
  OD_DEVSPACE_CONTROL_STATUS_URL
  OD_DEVSPACE_ACCESS_TOKEN
  OD_DEVSPACE_RUN_ID
  OD_DEVSPACE_MCP_COMMAND
  OD_DEVSPACE_MCP_ARGS
  OD_CHATGPT_WEB_RUNNER
  OD_CHATGPT_WEB_RUNNER_ARGS

Protocol:
  ${CHATGPT_WEB_BRIDGE_PROTOCOL}
`;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseRunArgs(argv: string[]): ParsedRunArgs {
  const parsed: ParsedRunArgs = {
    cwd: process.cwd(),
    imagePaths: [],
    runnerArgs: [],
    mcpArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      parsed.cwd = resolve(requireValue(argv, index, arg));
      index += 1;
    } else if (arg === '--prompt') {
      parsed.prompt = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--prompt-file') {
      parsed.promptFile = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--image') {
      parsed.imagePaths.push(resolve(requireValue(argv, index, arg)));
      index += 1;
    } else if (arg === '--mcp-url') {
      parsed.mcpUrl = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--devspace-run-id') {
      parsed.devspaceRunId = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--mcp-command') {
      parsed.mcpCommand = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--mcp-arg') {
      parsed.mcpArgs.push(requireValue(argv, index, arg));
      index += 1;
    } else if (arg === '--runner') {
      parsed.runner = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--runner-arg') {
      parsed.runnerArgs.push(requireValue(argv, index, arg));
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('__HELP__');
    } else {
      throw new Error(`Unknown run option: ${arg}`);
    }
  }

  if (parsed.prompt !== undefined && parsed.promptFile !== undefined) {
    throw new Error('Use only one of --prompt or --prompt-file.');
  }
  if (parsed.mcpUrl && parsed.mcpCommand) {
    throw new Error('Use only one of --mcp-url or --mcp-command.');
  }
  return parsed;
}

function runnerFromArgs(parsed: ParsedRunArgs): ChatGptWebRunnerConfig {
  const fromEnv = resolveChatGptWebRunnerConfig();
  if (parsed.runner) {
    return { bin: parsed.runner, args: parsed.runnerArgs };
  }
  if (fromEnv) {
    return parsed.runnerArgs.length > 0
      ? { bin: fromEnv.bin, args: [...fromEnv.args, ...parsed.runnerArgs] }
      : fromEnv;
  }
  return {
    bin: process.execPath,
    args: [BUNDLED_DEVSPACE_RUNNER, ...parsed.runnerArgs],
  };
}

function runnerEnv(parsed: ParsedRunArgs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (parsed.mcpUrl) env.OD_DEVSPACE_MCP_URL = parsed.mcpUrl;
  if (parsed.devspaceRunId) env.OD_DEVSPACE_RUN_ID = parsed.devspaceRunId;
  if (parsed.mcpCommand) env.OD_DEVSPACE_MCP_COMMAND = parsed.mcpCommand;
  if (parsed.mcpArgs.length > 0) env.OD_DEVSPACE_MCP_ARGS = JSON.stringify(parsed.mcpArgs);
  return env;
}

async function resolvePrompt(parsed: ParsedRunArgs, io: CliIo): Promise<string> {
  if (parsed.prompt !== undefined) return parsed.prompt;
  if (parsed.promptFile !== undefined && parsed.promptFile !== '-') {
    return readFile(resolve(parsed.promptFile), 'utf8');
  }
  if (io.stdin.isTTY) {
    throw new Error('No prompt provided. Pass --prompt, --prompt-file, or pipe a prompt on stdin.');
  }
  return readStream(io.stdin);
}

async function runCommand(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseRunArgs(argv);
  const prompt = await resolvePrompt(parsed, io);
  if (!prompt.trim()) throw new Error('Prompt is empty.');

  const result = await runChatGptWebBridge({
    cwd: parsed.cwd,
    prompt,
    imagePaths: parsed.imagePaths,
    runner: runnerFromArgs(parsed),
    env: runnerEnv(parsed),
    onEvent: (event) => {
      io.stdout.write(`${JSON.stringify(event)}\n`);
    },
    onRunnerStderr: (chunk) => {
      io.stderr.write(chunk);
    },
  });

  return result.terminalEvent.type === 'error' ? 1 : 0;
}

async function doctorCommand(argv: string[], io: CliIo): Promise<number> {
  let json = false;
  let runnerOverride: string | undefined;
  const runnerArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--runner') {
      runnerOverride = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--runner-arg') {
      runnerArgs.push(requireValue(argv, index, arg));
      index += 1;
    } else {
      throw new Error(`Unknown doctor option: ${arg}`);
    }
  }

  const envRunner = resolveChatGptWebRunnerConfig();
  const runner = runnerOverride
    ? { bin: runnerOverride, args: runnerArgs }
    : envRunner
      ? { bin: envRunner.bin, args: [...envRunner.args, ...runnerArgs] }
      : { bin: process.execPath, args: [BUNDLED_DEVSPACE_RUNNER, ...runnerArgs] };
  const result = await doctorChatGptWebBridge(runner);

  if (json) {
    io.stdout.write(`${JSON.stringify({ protocol: CHATGPT_WEB_BRIDGE_PROTOCOL, ...result })}\n`);
  } else if (result.ok && result.runner) {
    io.stdout.write(`ChatGPT Web bridge: ready\nRunner: ${result.runner.bin}\n`);
  } else {
    io.stdout.write('ChatGPT Web bridge: not ready\n');
    for (const issue of result.issues) io.stdout.write(`- ${issue}\n`);
  }
  return result.ok ? 0 : 1;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  io: CliIo = { stdin: processStdin, stdout: processStdout, stderr: processStderr },
): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (!command || command === '--help' || command === '-h') {
      io.stdout.write(usage());
      return 0;
    }
    if (command === '--version' || command === '-V') {
      io.stdout.write(`od-chatgpt-web ${BRIDGE_CLI_VERSION} (${CHATGPT_WEB_BRIDGE_PROTOCOL})\n`);
      return 0;
    }
    if (command === 'doctor') return doctorCommand(rest, io);
    if (command === 'run') return runCommand(rest, io);
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof Error && error.message === '__HELP__') {
      io.stdout.write(usage());
      return 0;
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
