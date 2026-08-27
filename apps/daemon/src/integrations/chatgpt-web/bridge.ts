import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
  CHATGPT_WEB_BRIDGE_PROTOCOL,
  isTerminalChatGptWebBridgeEvent,
  parseChatGptWebBridgeEvent,
  type ChatGptWebBridgeEvent,
  type ChatGptWebRunRequest,
} from './protocol.js';

export interface ChatGptWebRunnerConfig {
  bin: string;
  args: string[];
}

export interface RunChatGptWebBridgeOptions {
  cwd: string;
  prompt: string;
  imagePaths?: string[];
  metadata?: Record<string, string>;
  runner: ChatGptWebRunnerConfig;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: ChatGptWebBridgeEvent) => void;
  onRunnerStderr?: (chunk: string) => void;
}

export interface RunChatGptWebBridgeResult {
  requestId: string;
  terminalEvent: Extract<ChatGptWebBridgeEvent, { type: 'done' | 'error' }>;
  exitCode: number;
}

export interface ChatGptWebDoctorResult {
  ok: boolean;
  runner: ChatGptWebRunnerConfig | null;
  issues: string[];
}

function parseRunnerArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `OD_CHATGPT_WEB_RUNNER_ARGS must be a JSON string array: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('OD_CHATGPT_WEB_RUNNER_ARGS must be a JSON string array.');
  }
  return parsed;
}

export function resolveChatGptWebRunnerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ChatGptWebRunnerConfig | null {
  const bin = env.OD_CHATGPT_WEB_RUNNER?.trim();
  if (!bin) return null;
  return {
    bin,
    args: parseRunnerArgs(env.OD_CHATGPT_WEB_RUNNER_ARGS),
  };
}

export async function doctorChatGptWebBridge(
  runner: ChatGptWebRunnerConfig | null,
): Promise<ChatGptWebDoctorResult> {
  const issues: string[] = [];
  if (!runner) {
    issues.push('OD_CHATGPT_WEB_RUNNER is not configured.');
    return { ok: false, runner: null, issues };
  }

  if (runner.bin.includes('/') || runner.bin.includes('\\')) {
    try {
      await access(runner.bin, fsConstants.X_OK);
    } catch {
      issues.push(`ChatGPT Web runner is not executable: ${runner.bin}`);
    }
  }

  return { ok: issues.length === 0, runner, issues };
}

export async function runChatGptWebBridge(
  options: RunChatGptWebBridgeOptions,
): Promise<RunChatGptWebBridgeResult> {
  const requestId = randomUUID();
  const request: ChatGptWebRunRequest = {
    protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
    type: 'run',
    requestId,
    cwd: options.cwd,
    prompt: options.prompt,
    imagePaths: options.imagePaths ?? [],
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };

  const child = spawn(options.runner.bin, options.runner.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      OD_CHATGPT_WEB_PROTOCOL: CHATGPT_WEB_BRIDGE_PROTOCOL,
      OD_CHATGPT_WEB_REQUEST_ID: requestId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let spawnError: Error | null = null;
  child.once('error', (error) => {
    spawnError = error;
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    options.onRunnerStderr?.(chunk);
  });

  const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let terminalEvent: Extract<ChatGptWebBridgeEvent, { type: 'done' | 'error' }> | null = null;
  let streamError: Error | null = null;

  const consumeOutput = (async () => {
    try {
      for await (const rawLine of lineReader) {
        const line = rawLine.trim();
        if (!line) continue;
        const event = parseChatGptWebBridgeEvent(line);
        if (event.requestId !== requestId) {
          throw new Error(
            `ChatGPT Web runner returned requestId ${event.requestId}; expected ${requestId}.`,
          );
        }
        options.onEvent?.(event);
        if (isTerminalChatGptWebBridgeEvent(event)) {
          terminalEvent = event;
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
    }
  })();

  child.stdin.end(`${JSON.stringify(request)}\n`);

  const exitCode = await new Promise<number>((resolve) => {
    child.once('close', (code) => resolve(code ?? 1));
  });
  await consumeOutput;

  if (spawnError) throw spawnError;
  if (streamError) throw streamError;
  if (!terminalEvent) {
    throw new Error(
      `ChatGPT Web runner exited with code ${exitCode} without a terminal done/error event.`,
    );
  }
  if (exitCode !== 0 && terminalEvent.type !== 'error') {
    throw new Error(`ChatGPT Web runner exited with code ${exitCode} after reporting done.`);
  }

  return { requestId, terminalEvent, exitCode };
}
