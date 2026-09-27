import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

import { ClaudeCodeAgent, setClaudeSupportedModelsListener } from '../index.js';

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createAgent(authenticated: boolean): { agent: ClaudeCodeAgent; getState: ReturnType<typeof vi.fn> } {
  const getState = vi.fn(async () => (authenticated ? { authenticated: true } : { authenticated: false }));
  const auth: AuthAdapter = {
    getState,
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };
  const deps: AgentDeps = {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createNoopLogger(),
  };
  return { agent: new ClaudeCodeAgent(deps), getState };
}

function fakeQuery(supportedModels: () => Promise<unknown[]>) {
  return { supportedModels: vi.fn(supportedModels), close: vi.fn() };
}

afterEach(() => {
  setClaudeSupportedModelsListener(null);
  sdkMock.query.mockReset();
});

describe('ClaudeCodeAgent.refreshLocalModels(主动读取订阅模型清单)', () => {
  it('用订阅登录起空闲 Query 只读 supportedModels,交给 host 后关闭,不发送任何消息', async () => {
    const listener = vi.fn();
    setClaudeSupportedModelsListener(listener);
    const models = [{ value: 'claude-fable-5-1', displayName: 'Fable' }];
    const q = fakeQuery(async () => models);
    sdkMock.query.mockReturnValue(q);
    const { agent, getState } = createAgent(true);

    await expect(agent.refreshLocalModels()).resolves.toBe(true);

    expect(getState).toHaveBeenCalledWith({ credentialMode: 'oauth-bearer' });
    expect(listener).toHaveBeenCalledWith(models);
    expect(q.close).toHaveBeenCalledTimes(1);
    const [{ prompt, options }] = sdkMock.query.mock.calls[0] as [
      { prompt: AsyncIterable<unknown>; options: Record<string, unknown> },
    ];
    expect(options.pathToClaudeCodeExecutable).toBe(process.execPath);
    // 输入队列在探测结束时关闭且从未写入:没有任何用户消息发往模型。
    const received: unknown[] = [];
    for await (const item of prompt) received.push(item);
    expect(received).toEqual([]);
  });

  it('未登录订阅或 host 未接监听器时不起 CLI', async () => {
    const { agent: unauthed } = createAgent(false);
    setClaudeSupportedModelsListener(vi.fn());
    await expect(unauthed.refreshLocalModels()).resolves.toBe(false);

    setClaudeSupportedModelsListener(null);
    const { agent: noListener } = createAgent(true);
    await expect(noListener.refreshLocalModels()).resolves.toBe(false);

    expect(sdkMock.query).not.toHaveBeenCalled();
  });

  it('并发请求共用同一次探测', async () => {
    setClaudeSupportedModelsListener(vi.fn());
    let release!: (value: unknown[]) => void;
    const q = fakeQuery(() => new Promise<unknown[]>((resolve) => { release = resolve; }));
    sdkMock.query.mockReturnValue(q);
    const { agent } = createAgent(true);

    const first = agent.refreshLocalModels();
    const second = agent.refreshLocalModels();
    await vi.waitFor(() => expect(q.supportedModels).toHaveBeenCalled());
    release([]);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(sdkMock.query).toHaveBeenCalledTimes(1);
  });

  it('读取失败返回 false 并仍关闭 Query', async () => {
    const listener = vi.fn();
    setClaudeSupportedModelsListener(listener);
    const q = fakeQuery(async () => {
      throw new Error('cli exited');
    });
    sdkMock.query.mockReturnValue(q);
    const { agent } = createAgent(true);

    await expect(agent.refreshLocalModels()).resolves.toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(q.close).toHaveBeenCalledTimes(1);
  });
});
