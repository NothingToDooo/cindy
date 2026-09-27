import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withImportedConnection } from '../connections.js';
let directory: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
it('queries a real stdio MCP subprocess with the imported credential after a new connection', async () => {
  vi.stubEnv('CINDY_UNRELATED_TEST_SECRET', 'fixture-launch-secret');
  vi.stubEnv('HTTPS_PROXY', 'http://fixture-user:fixture-password@example.invalid');
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-mcp-test-'));
  const file = path.join(directory, 'server.cjs');
  await fs.writeFile(file, `const readline = require('node:readline'); let reads = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line); if (!('id' in r)) return;
 const result = r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 : r.method === 'tools/list' ? {tools:[{name:'read_data',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}
 : {content:[{type:'text',text:JSON.stringify({authenticated:process.env.DATA_TOKEN === 'fixture-mcp-key',isolated:!process.env.CINDY_UNRELATED_TEST_SECRET && !process.env.HTTPS_PROXY,rows:[{id:1}],reads:++reads})}]};
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
  expect(payload(first).isolated).toBe(true);
  expect(payload(second).reads).toBe(2);
  // A failed request discards the cached subprocess and leaves no fixture running.
  await expect(withImportedConnection(connection, {}, () => {}, async () => { throw new Error('fixture disconnect'); }, scope)).rejects.toThrow('CONNECTION_FAILED');
});

it('terminates an idle credential subprocess after its owner changes and evicts it without affecting another owner', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-idle-mcp-test-'));
  const file = path.join(directory, 'server.cjs');
  await fs.writeFile(file, `const readline = require('node:readline'); let reads = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line); if (!('id' in r)) return;
 const result = r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 : {content:[{type:'text',text:JSON.stringify({pid:process.pid,reads:++reads,authenticated:process.env.DATA_TOKEN === 'fixture-token'})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`);
  const server = { name: 'fixture', command: process.execPath, args: [file] };
  let current = true;
  const assertOwner = () => { if (!current) throw new Error('OWNER_CHANGED'); };
  const old = { identity: `${directory}:old`, signal: new AbortController().signal };
  const other = { identity: `${directory}:other`, signal: new AbortController().signal };
  const read = async (scope: typeof old, assert: () => void) => {
    const result = await withImportedConnection(server, { DATA_TOKEN: 'fixture-token' }, assert, client => client.callTool({ name: 'read', arguments: {} }), scope);
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { pid: number; reads: number; authenticated: boolean };
  };
  try {
    const first = await read(old, assertOwner); const healthy = await read(other, () => {});
    expect(first.authenticated).toBe(true);
    current = false;
    // No second call is made on the old connection: the idle fence itself closes it.
    await vi.waitFor(() => expect(() => process.kill(first.pid, 0)).toThrow(), { timeout: 5000, interval: 50 });
    expect(await read(other, () => {})).toMatchObject({ pid: healthy.pid, reads: 2 });
    const replacement = await read(old, () => {});
    expect(replacement.pid).not.toBe(first.pid); expect(replacement.reads).toBe(1);
  } finally {
    current = false;
    for (const scope of [old, other]) await withImportedConnection(server, {}, () => {}, async () => { throw new Error('fixture cleanup'); }, scope).catch(() => {});
  }
});
