import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
vi.mock('@cindy/mcps', () => ({ resolveLiziMcpSessionContext: () => ({ sessionId: 'fixture-session' }) }));
vi.mock('../runtime.js', () => ({ readCompanionSessionEnvironment: vi.fn() }));
import { readCompanionSessionEnvironment } from '../runtime.js';
import { createCompanionConnectionsProvider } from '../connectionProvider.js';
import { redactEnvironmentData } from '../process.js';
let root: string | undefined;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('uses original credentials in a real imported command and redacts arbitrary names from its response', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-command-test-'));
  await fs.mkdir(path.join(root, 'bots/bot'), { recursive: true });
  const env = { GITHUB_PAT: 'fixture-pat', DATABASE_URL: 'postgres://fixture:secret@example.invalid/db', ALIAS: 'short' };
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: 'fixture', botId: 'bot', userData: root, assertOwner() {}, environment: { version: 1, env, mcp: [], credentials: [] } });
  const provider = createCompanionConnectionsProvider();
  const config = await provider.toClaudeSdkConfig!({} as never) as { type: string; instance: McpServer };
  if (config?.type !== 'sdk') throw new Error('Expected SDK bridge');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    expect((await client.listTools()).tools.some(tool => tool.name === 'run_command')).toBe(true);
    const result = await client.callTool({ name: 'run_command', arguments: { command: 'test "$ALIAS" = "short" && printf "authenticated %s %s %s" "$GITHUB_PAT" "$DATABASE_URL" "$ALIAS"' } });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain('authenticated');
    for (const value of Object.values(env)) expect(JSON.stringify(result)).not.toContain(value);
    expect(process.env.GITHUB_PAT).not.toBe(env.GITHUB_PAT);
  } finally { await client.close(); await config.instance.close(); }
});

it('preserves structured numeric data while redacting string credentials without name or length heuristics', () => {
  expect(redactEnvironmentData({ count: 1, value: '1', key: 'a+b', nested: ['x'] }, { arbitrary: 'a+b', code: '1', another: 'x' }))
    .toEqual({ count: 1, value: '[code]', key: '[arbitrary]', nested: ['[another]'] });
});
