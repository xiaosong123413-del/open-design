import { describe, expect, it } from 'vitest';
import {
  doctorChatGptWebBridge,
  runChatGptWebBridge,
} from '../../src/integrations/chatgpt-web/bridge.js';
import {
  CHATGPT_WEB_BRIDGE_PROTOCOL,
  parseChatGptWebBridgeEvent,
} from '../../src/integrations/chatgpt-web/protocol.js';

describe('ChatGPT Web bridge protocol', () => {
  it('parses a valid text event', () => {
    const event = parseChatGptWebBridgeEvent(
      JSON.stringify({
        protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
        type: 'text',
        requestId: 'req-1',
        text: 'hello',
      }),
    );

    expect(event).toMatchObject({ type: 'text', requestId: 'req-1', text: 'hello' });
  });

  it('rejects events from a different protocol', () => {
    expect(() =>
      parseChatGptWebBridgeEvent(
        JSON.stringify({ protocol: 'other/1', type: 'done', requestId: 'req-1' }),
      ),
    ).toThrow(/Unsupported ChatGPT Web bridge protocol/u);
  });
});

describe('runChatGptWebBridge', () => {
  it('sends one run request and streams runner events', async () => {
    const runnerScript = `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => {
        const request = JSON.parse(input.trim());
        const base = { protocol: request.protocol, requestId: request.requestId };
        process.stdout.write(JSON.stringify({ ...base, type: 'status', message: 'connected' }) + '\\n');
        process.stdout.write(JSON.stringify({ ...base, type: 'text', text: 'working' }) + '\\n');
        process.stdout.write(JSON.stringify({ ...base, type: 'done', summary: 'finished' }) + '\\n');
      });
    `;
    const events: string[] = [];

    const result = await runChatGptWebBridge({
      cwd: process.cwd(),
      prompt: 'Build a settings page',
      runner: { bin: process.execPath, args: ['-e', runnerScript] },
      onEvent: (event) => events.push(event.type),
    });

    expect(events).toEqual(['status', 'text', 'done']);
    expect(result.exitCode).toBe(0);
    expect(result.terminalEvent).toMatchObject({ type: 'done', summary: 'finished' });
  });

  it('rejects a runner that never emits a terminal event', async () => {
    const runnerScript = `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => {
        const request = JSON.parse(input.trim());
        process.stdout.write(JSON.stringify({
          protocol: request.protocol,
          requestId: request.requestId,
          type: 'status',
          message: 'connected'
        }) + '\\n');
      });
    `;

    await expect(
      runChatGptWebBridge({
        cwd: process.cwd(),
        prompt: 'Build a settings page',
        runner: { bin: process.execPath, args: ['-e', runnerScript] },
      }),
    ).rejects.toThrow(/without a terminal done\/error event/u);
  });
});

describe('doctorChatGptWebBridge', () => {
  it('reports missing runner configuration', async () => {
    await expect(doctorChatGptWebBridge(null)).resolves.toEqual({
      ok: false,
      runner: null,
      issues: ['OD_CHATGPT_WEB_RUNNER is not configured.'],
    });
  });
});
