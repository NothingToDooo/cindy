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
import * as connectionModule from '../connections.js';
import { connectionRedactions, redactImportedTool } from '../connectionCatalog.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
let root: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (root) await fs.rm(root, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('uses original credentials in a real imported command and redacts arbitrary names from its response', async () => {
  vi.stubEnv('CINDY_UNRELATED_TEST_SECRET', 'fixture-launch-secret');
  vi.stubEnv('HTTPS_PROXY', 'http://fixture-user:fixture-password@example.invalid');
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
    const result = await client.callTool({ name: 'run_command', arguments: { command: 'test -z "$CINDY_UNRELATED_TEST_SECRET" && test -z "$HTTPS_PROXY" && test "$ALIAS" = "short" && printf "authenticated %s %s %s" "$GITHUB_PAT" "$DATABASE_URL" "$ALIAS"' } });
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

it('redacts resolved catalog credentials without changing schema syntax, tool dispatch or connection configuration', async () => {
  const env = { TOKEN: 'fixture-global-token', TYPE: 'object' };
  const connection = { name: 'fixture-server', url: 'https://fixture-user:fixture-password@example.invalid/mcp?key=fixture-url-key',
    env: { TOKEN: 'fixture-local-token' }, headers: { Authorization: 'Bearer fixture-header-token', 'X-Api-Key': 'fixture-api-key' } };
  const secrets = [env.TOKEN, connection.env.TOKEN, connection.headers.Authorization, 'fixture-header-token', connection.headers['X-Api-Key'], connection.url, 'fixture-user', 'fixture-password', 'fixture-url-key'];
  const echo = secrets.join(' ');
  const tool: Tool = { name: `read_${connection.env.TOKEN}`, title: echo, description: echo,
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: echo, default: echo }, count: { type: 'integer', minimum: 1 } }, required: ['query'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { result: { type: ['object', 'null'], description: echo, examples: [{ note: echo }] } } },
    annotations: { title: echo, readOnlyHint: true }, _meta: { debug: [echo] } };
  const original = structuredClone({ tool, connection, env });
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: echo }], structuredContent: { rows: 2, authenticated: true } }));
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (server, environment, assert, run) => {
    expect(server).toEqual(original.connection); expect(environment).toEqual(original.env); assert();
    return run({ listTools: async () => ({ tools: [tool] }), callTool } as never);
  });
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: 'catalog-fixture', botId: 'bot', userData: '/fixture', assertOwner() {}, environment: { version: 1, env, mcp: [connection], credentials: [] } });
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(2);
    for (const secret of secrets) expect(JSON.stringify(catalog)).not.toContain(secret);
    const importedTool = catalog.tools[1]!;
    expect(importedTool.inputSchema).toMatchObject({ type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer', minimum: 1 } }, required: ['query'], additionalProperties: false });
    expect(importedTool.outputSchema).toMatchObject({ type: 'object', properties: { result: { type: ['object', 'null'] } } });
    expect(importedTool.annotations?.readOnlyHint).toBe(true);
    const result = await client.callTool({ name: importedTool.name, arguments: { query: 'ordinary data', count: 2 } });
    expect(callTool).toHaveBeenCalledWith({ name: tool.name, arguments: { query: 'ordinary data', count: 2 } }, undefined, { timeout: 120000 });
    for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.structuredContent).toEqual({ rows: 2, authenticated: true });
    expect({ tool, connection, env }).toEqual(original);
    expect(redactImportedTool({ ...tool, name: 'ordinary_read' }, connectionRedactions(connection, env)).name).toBe('ordinary_read');
  } finally { imported.mockRestore(); await client.close(); await config.instance.close(); }
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
