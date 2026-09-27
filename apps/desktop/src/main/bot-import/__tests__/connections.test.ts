import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withImportedConnection } from '../connections.js';
let directory: string | undefined;
afterEach(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });
it('queries a real stdio MCP subprocess with the imported credential after a new connection', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-mcp-test-'));
  const file = path.join(directory, 'server.cjs');
  await fs.writeFile(file, `const readline = require('node:readline'); let reads = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line); if (!('id' in r)) return;
 const result = r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 : r.method === 'tools/list' ? {tools:[{name:'read_data',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}
 : {content:[{type:'text',text:JSON.stringify({authenticated:process.env.DATA_TOKEN === 'fixture-mcp-key',rows:[{id:1}],reads:++reads})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`);
  const connection = { name: 'fixture', command: process.execPath, args: [file], transport: 'stdio' as const };
  await withImportedConnection(connection, { DATA_TOKEN: 'fixture-mcp-key' }, () => {}, async client => {
    expect((await client.listTools()).tools[0]?.name).toBe('read_data');
  });
  const result = await withImportedConnection(connection, { DATA_TOKEN: 'fixture-mcp-key' }, () => {}, client => client.callTool({ name: 'read_data', arguments: {} }));
  expect(JSON.stringify(result)).toContain('authenticated');
  expect(JSON.stringify(result)).toContain('true');
  expect(JSON.stringify(result)).not.toContain('fixture-mcp-key');
  const scope = { identity: 'fixture-companion', signal: new AbortController().signal };
  const first = await withImportedConnection(connection, { DATA_TOKEN: 'fixture-mcp-key' }, () => {}, client => client.callTool({ name: 'read_data', arguments: {} }), scope);
  const second = await withImportedConnection(connection, { DATA_TOKEN: 'fixture-mcp-key' }, () => {}, client => client.callTool({ name: 'read_data', arguments: {} }), scope);
  const payload = (value: unknown) => JSON.parse((value as { content: Array<{ text: string }> }).content[0]!.text);
  expect(payload(first).reads).toBe(1);
  expect(payload(second).reads).toBe(2);
  // A failed request discards the cached subprocess and leaves no fixture running.
  await expect(withImportedConnection(connection, {}, () => {}, async () => { throw new Error('fixture disconnect'); }, scope)).rejects.toThrow('CONNECTION_FAILED');
});
