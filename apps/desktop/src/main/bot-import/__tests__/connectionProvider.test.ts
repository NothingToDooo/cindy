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
import { withImportedConnection } from '../connections.js';
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

it('keeps healthy tools and commands available when another server is stopped or fails during pagination', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-catalog-test-'));
  await fs.mkdir(path.join(root, 'bots/bot'), { recursive: true });
  const file = path.join(root, 'server.cjs');
  await fs.writeFile(file, `const readline = require('node:readline');
const mode = process.argv[2];
readline.createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line); if (!('id' in r)) return;
 if (mode === 'paged' && r.method === 'tools/list' && r.params.cursor) {
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'private upstream failure'}})+'\\n'); return;
 }
 const result=r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 : r.method === 'tools/list' ? {tools:[{name:mode,inputSchema:{type:'object'}}],...(mode === 'paged' ? {nextCursor:'next'} : {})}
 : {content:[{type:'text',text:'healthy data'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`);
  const mcp = [
    { name: 'stopped', command: path.join(root, 'missing-server'), args: [] },
    { name: 'paged', command: process.execPath, args: [file, 'paged'] },
    { name: 'healthy', command: process.execPath, args: [file, 'healthy'] },
  ];
  const scope = { identity: root, botId: 'bot', userData: root, assertOwner() {}, environment: { version: 1 as const, env: {}, mcp, credentials: [] } };
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue(scope);
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(2);
    expect(catalog.tools[0]?.name).toBe('run_command');
    expect(catalog.tools[0]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(catalog.tools[1]?.description).toContain('healthy');
    const result = await client.callTool({ name: catalog.tools[1]!.name, arguments: {} });
    expect(JSON.stringify(result)).toContain('healthy data');
    const command = await client.callTool({ name: 'run_command', arguments: { command: 'echo independent' } });
    expect(command.isError).toBe(false);
    expect(JSON.stringify(command)).toContain('independent');
    expect(JSON.stringify(catalog)).not.toContain('private upstream failure');
    scope.assertOwner = () => { throw new Error('OWNER_CHANGED'); };
    await expect(client.listTools()).rejects.toThrow('OWNER_CHANGED');
  } finally {
    await client.close(); await config.instance.close();
    // Dispose the cached healthy fixture process; failed catalogs already close theirs.
    await withImportedConnection(mcp[2]!, {}, () => {}, async () => { throw new Error('fixture cleanup'); }, { identity: scope.identity, signal: new AbortController().signal }).catch(() => {});
  }
});
