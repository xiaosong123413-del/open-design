import { describe, expect, it } from 'vitest';
import {
  classifyAgentState,
  discoverDevSpaceMcpUrl,
  findStringByKeys,
  parseBridgeRequest,
  resolveDevSpaceMcpRunnerConfig,
} from '../../src/integrations/chatgpt-web/devspace-mcp-runner.js';
import { CHATGPT_WEB_BRIDGE_PROTOCOL } from '../../src/integrations/chatgpt-web/protocol.js';

describe('DevSpace MCP runner config', () => {
  it('uses an explicit DevSpace MCP URL when configured', () => {
    expect(
      resolveDevSpaceMcpRunnerConfig({
        OD_DEVSPACE_MCP_URL: 'http://127.0.0.1:43123/mcp',
        OD_DEVSPACE_ACCESS_TOKEN: 'access-token',
        OD_DEVSPACE_RUN_ID: 'run-123',
        OD_DEVSPACE_POLL_MS: '250',
        OD_DEVSPACE_TIMEOUT_MS: '5000',
      }),
    ).toEqual({
      transport: { kind: 'http', url: 'http://127.0.0.1:43123/mcp', accessToken: 'access-token' },
      runId: 'run-123',
      pollMs: 250,
      timeoutMs: 5000,
    });
  });

  it('supports an explicit stdio MCP server as a fallback', () => {
    expect(
      resolveDevSpaceMcpRunnerConfig({
        OD_DEVSPACE_MCP_COMMAND: 'devspace-mcp',
        OD_DEVSPACE_MCP_ARGS: '["--stdio"]',
        OD_DEVSPACE_RUN_ID: 'run-123',
      }),
    ).toMatchObject({
      transport: { kind: 'stdio', command: 'devspace-mcp', args: ['--stdio'] },
      runId: 'run-123',
    });
  });

  it('defaults to the DevSpace desktop control status discovery endpoint', () => {
    expect(resolveDevSpaceMcpRunnerConfig({ OD_DEVSPACE_RUN_ID: 'run-123' })).toMatchObject({
      transport: {
        kind: 'discover',
        controlStatusUrl: 'http://127.0.0.1:7676/control/status',
      },
      runId: 'run-123',
    });
  });

  it('requires a persistent DevSpace run binding', () => {
    expect(() =>
      resolveDevSpaceMcpRunnerConfig({ OD_DEVSPACE_MCP_URL: 'http://127.0.0.1:43123/mcp' }),
    ).toThrow(/OD_DEVSPACE_RUN_ID/u);
  });

  it('rejects invalid MCP and discovery URLs', () => {
    expect(() =>
      resolveDevSpaceMcpRunnerConfig({
        OD_DEVSPACE_MCP_URL: 'file:///tmp/devspace',
        OD_DEVSPACE_RUN_ID: 'run-123',
      }),
    ).toThrow(/must use http or https/u);
    expect(() =>
      resolveDevSpaceMcpRunnerConfig({
        OD_DEVSPACE_CONTROL_STATUS_URL: 'file:///tmp/devspace-status',
        OD_DEVSPACE_RUN_ID: 'run-123',
      }),
    ).toThrow(/OD_DEVSPACE_CONTROL_STATUS_URL must use http or https/u);
  });

  it('rejects configuring HTTP and stdio transports together', () => {
    expect(() =>
      resolveDevSpaceMcpRunnerConfig({
        OD_DEVSPACE_MCP_URL: 'http://127.0.0.1:43123/mcp',
        OD_DEVSPACE_MCP_COMMAND: 'devspace-mcp',
        OD_DEVSPACE_RUN_ID: 'run-123',
      }),
    ).toThrow(/only one DevSpace MCP transport/u);
  });

  it('rejects non-array MCP args', () => {
    expect(() =>
      resolveDevSpaceMcpRunnerConfig({
        OD_DEVSPACE_MCP_COMMAND: 'devspace-mcp',
        OD_DEVSPACE_MCP_ARGS: '"--stdio"',
        OD_DEVSPACE_RUN_ID: 'run-123',
      }),
    ).toThrow(/OD_DEVSPACE_MCP_ARGS must be a JSON string array/u);
  });
});

describe('DevSpace MCP endpoint discovery', () => {
  it('reads the real endpoint shape from DevSpace control status', async () => {
    const fetchFn = async (): Promise<Response> => new Response(
      JSON.stringify({ status: 'ok', mcpUrl: 'https://devspace.example.test/mcp' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    await expect(
      discoverDevSpaceMcpUrl('http://127.0.0.1:7676/control/status', fetchFn),
    ).resolves.toBe('https://devspace.example.test/mcp');
  });

  it('rejects missing mcpUrl and failed control status responses', async () => {
    await expect(
      discoverDevSpaceMcpUrl(
        'http://127.0.0.1:7676/control/status',
        async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      ),
    ).rejects.toThrow(/did not provide a non-empty mcpUrl/u);

    await expect(
      discoverDevSpaceMcpUrl(
        'http://127.0.0.1:7676/control/status',
        async () => new Response('offline', { status: 503 }),
      ),
    ).rejects.toThrow(/HTTP 503/u);
  });
});

describe('DevSpace MCP bridge request parsing', () => {
  it('accepts an od-chatgpt-web run request', () => {
    const request = parseBridgeRequest(
      JSON.stringify({
        protocol: CHATGPT_WEB_BRIDGE_PROTOCOL,
        type: 'run',
        requestId: 'req-1',
        cwd: '/project',
        prompt: 'Design a dashboard',
        imagePaths: [],
      }),
    );

    expect(request).toMatchObject({ requestId: 'req-1', cwd: '/project', prompt: 'Design a dashboard' });
  });

  it('rejects the wrong protocol', () => {
    expect(() =>
      parseBridgeRequest(
        JSON.stringify({
          protocol: 'wrong/1',
          type: 'run',
          requestId: 'req-1',
          cwd: '/project',
          prompt: 'Design a dashboard',
          imagePaths: [],
        }),
      ),
    ).toThrow(/Unsupported bridge protocol/u);
  });
});

describe('DevSpace MCP agent result normalization', () => {
  it('finds nested identifiers and replies', () => {
    expect(
      findStringByKeys(
        { result: { agent: { agent_id: 'agent-9' } } },
        ['agentId', 'agent_id'],
      ),
    ).toBe('agent-9');
  });

  it('classifies completed, failed, waiting, and working states', () => {
    expect(classifyAgentState({ status: 'completed' })).toBe('completed');
    expect(classifyAgentState({ state: 'failed' })).toBe('failed');
    expect(classifyAgentState({ review_state: 'waiting' })).toBe('waiting');
    expect(classifyAgentState({ status: 'running' })).toBe('working');
  });

  it('treats a materialized result as terminal completion when status is absent', () => {
    expect(classifyAgentState({ result: { summary: 'done' } })).toBe('completed');
  });
});
