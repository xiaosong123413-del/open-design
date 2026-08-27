export const CHATGPT_WEB_BRIDGE_PROTOCOL = 'od-chatgpt-web/1' as const;

export interface ChatGptWebRunRequest {
  protocol: typeof CHATGPT_WEB_BRIDGE_PROTOCOL;
  type: 'run';
  requestId: string;
  cwd: string;
  prompt: string;
  imagePaths: string[];
  metadata?: Record<string, string>;
}

export type ChatGptWebBridgeEvent =
  | {
      protocol: typeof CHATGPT_WEB_BRIDGE_PROTOCOL;
      type: 'session';
      requestId: string;
      sessionId: string;
    }
  | {
      protocol: typeof CHATGPT_WEB_BRIDGE_PROTOCOL;
      type: 'status';
      requestId: string;
      message: string;
    }
  | {
      protocol: typeof CHATGPT_WEB_BRIDGE_PROTOCOL;
      type: 'text';
      requestId: string;
      text: string;
    }
  | {
      protocol: typeof CHATGPT_WEB_BRIDGE_PROTOCOL;
      type: 'tool';
      requestId: string;
      name: string;
      phase: 'start' | 'result';
      detail?: string;
      isError?: boolean;
    }
  | {
      protocol: typeof CHATGPT_WEB_BRIDGE_PROTOCOL;
      type: 'artifact';
      requestId: string;
      path: string;
      action: 'created' | 'updated' | 'deleted';
    }
  | {
      protocol: typeof CHATGPT_WEB_BRIDGE_PROTOCOL;
      type: 'preview';
      requestId: string;
      url: string;
    }
  | {
      protocol: typeof CHATGPT_WEB_BRIDGE_PROTOCOL;
      type: 'done';
      requestId: string;
      summary?: string;
    }
  | {
      protocol: typeof CHATGPT_WEB_BRIDGE_PROTOCOL;
      type: 'error';
      requestId: string;
      code: string;
      message: string;
      recoverable?: boolean;
    };

export type ChatGptWebBridgeTerminalEvent = Extract<
  ChatGptWebBridgeEvent,
  { type: 'done' | 'error' }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseChatGptWebBridgeEvent(line: string): ChatGptWebBridgeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `ChatGPT Web runner emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error('ChatGPT Web runner event must be a JSON object.');
  }
  if (parsed.protocol !== CHATGPT_WEB_BRIDGE_PROTOCOL) {
    throw new Error(
      `Unsupported ChatGPT Web bridge protocol: ${String(parsed.protocol ?? '<missing>')}`,
    );
  }
  if (typeof parsed.type !== 'string') {
    throw new Error('ChatGPT Web runner event is missing a string type.');
  }
  if (typeof parsed.requestId !== 'string' || parsed.requestId.length === 0) {
    throw new Error('ChatGPT Web runner event is missing requestId.');
  }

  const type = parsed.type;
  if (type === 'session') {
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) {
      throw new Error('session event is missing sessionId.');
    }
  } else if (type === 'status') {
    if (typeof parsed.message !== 'string') throw new Error('status event is missing message.');
  } else if (type === 'text') {
    if (typeof parsed.text !== 'string') throw new Error('text event is missing text.');
  } else if (type === 'tool') {
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
      throw new Error('tool event is missing name.');
    }
    if (parsed.phase !== 'start' && parsed.phase !== 'result') {
      throw new Error('tool event phase must be start or result.');
    }
    if (parsed.detail !== undefined && typeof parsed.detail !== 'string') {
      throw new Error('tool event detail must be a string when provided.');
    }
    if (parsed.isError !== undefined && typeof parsed.isError !== 'boolean') {
      throw new Error('tool event isError must be a boolean when provided.');
    }
  } else if (type === 'artifact') {
    if (typeof parsed.path !== 'string' || parsed.path.length === 0) {
      throw new Error('artifact event is missing path.');
    }
    if (parsed.action !== 'created' && parsed.action !== 'updated' && parsed.action !== 'deleted') {
      throw new Error('artifact event action must be created, updated, or deleted.');
    }
  } else if (type === 'preview') {
    if (typeof parsed.url !== 'string' || parsed.url.length === 0) {
      throw new Error('preview event is missing url.');
    }
  } else if (type === 'done') {
    if (parsed.summary !== undefined && typeof parsed.summary !== 'string') {
      throw new Error('done event summary must be a string when provided.');
    }
  } else if (type === 'error') {
    if (typeof parsed.code !== 'string' || parsed.code.length === 0) {
      throw new Error('error event is missing code.');
    }
    if (typeof parsed.message !== 'string' || parsed.message.length === 0) {
      throw new Error('error event is missing message.');
    }
    if (parsed.recoverable !== undefined && typeof parsed.recoverable !== 'boolean') {
      throw new Error('error event recoverable must be a boolean when provided.');
    }
  } else {
    throw new Error(`Unsupported ChatGPT Web runner event type: ${type}`);
  }

  return parsed as ChatGptWebBridgeEvent;
}

export function isTerminalChatGptWebBridgeEvent(
  event: ChatGptWebBridgeEvent,
): event is ChatGptWebBridgeTerminalEvent {
  return event.type === 'done' || event.type === 'error';
}
