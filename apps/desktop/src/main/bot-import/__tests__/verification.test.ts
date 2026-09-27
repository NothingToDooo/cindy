import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: vi.fn() }));
vi.mock('../../localDb/ipc/bots.js', () => ({ getBotRemoteResourceSource: vi.fn() }));
vi.mock('../runtime.js', () => ({ companionEnvironmentStore: { read: vi.fn() } }));
import { getMakerIfReady } from '../../maker-host/index.js';
import { getBotRemoteResourceSource } from '../../localDb/ipc/bots.js';
import { companionEnvironmentStore } from '../runtime.js';
import { matchesReadEvidence, readImportHttpEvidence, verifyImportedAutomation } from '../verification.js';
import { normalizeAutomation } from '../sourceAutomations.js';
import { resolveImportEnvironmentDependencies } from '../environmentSelection.js';
import type { ImportItem, ImportSource } from '../types.js';
import * as connectionModule from '../connections.js';
let server: Server | undefined;
afterEach(async () => { vi.unstubAllGlobals(); if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); }); server = undefined; });
it('checks actual authenticated response data and refuses redirects/error envelopes', async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/data' }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.headers.authorization === 'Bearer fixture-key' ? { result: { rows: [{ count: 7 }] } } : { error: 'unauthorized' }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const data = await readImportHttpEvidence(new URL('/data', base), { Authorization: 'Bearer fixture-key' });
  expect(matchesReadEvidence(data, '/result/rows', undefined, true)).toBe(true);
  const denied = await readImportHttpEvidence(new URL('/data', base), {});
  expect(matchesReadEvidence(denied, '', ['error'], false)).toBe(false);
  expect(matchesReadEvidence(data, '/missing', undefined, true)).toBe(false);
  await expect(readImportHttpEvidence(new URL('/redirect', base), {})).rejects.toThrow();
});

it('verifies a selected skill bundled script using real HTTP without giving the planner its key', async () => {
  let authorized = false;
  server = createServer((req, res) => {
    authorized = req.headers.authorization === 'Bearer fixture-private-token';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(authorized ? { rows: [{ count: 7 }] } : { success: false }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: { DATA_URL: base, DATA_TOKEN: 'fixture-private-token', UNSELECTED_TOKEN: 'unrelated-private-token' }, mcp: [], credentials: [] });
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ reads: [{ kind: 'http', baseVariable: 'DATA_URL', path: '/data', headers: { Authorization: { variable: 'DATA_TOKEN', prefix: 'Bearer ' } }, pointer: '/rows', array: true }] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const result = await verifyImportedAutomation('/fixture', 'bot', {
    view: { id: 'job', name: 'Daily', category: 'automations', selected: true, dependsOn: ['skill'] },
    automation: { sourceId: 'job', original: {}, fingerprint: 'fixture', input: { name: 'Daily', prompt: 'Read dashboard data', enabled: true, triggers: [],  } },
  }, () => {}, [{ view: { id: 'skill', name: 'dashboard', category: 'skills', selected: true }, files: [{ name: 'scripts/query.py', bytes: Buffer.from('url = os.environ["DATA_URL"]\ntoken = os.environ["DATA_TOKEN"]'), executable: false }] }]);
  expect(result.verified).toBe(true);
  expect(authorized).toBe(true);
  const prompt = oneShot.mock.calls[0]![1] as string;
  expect(prompt).toContain('scripts/query.py');
  expect(prompt).toContain('DATA_TOKEN');
  expect(prompt).not.toContain('fixture-private-token');
  expect(prompt).not.toContain('UNSELECTED_TOKEN');
});

it('rejects a plan that sends an allowed credential to an unrelated allowed origin before fetching', async () => {
  const env = { DATA_URL: 'https://data.example.invalid', DATA_TOKEN: 'fixture-private-token', ATTACKER_URL: 'https://attacker.example.invalid' };
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env, mcp: [], credentials: [] });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ reads: [{ kind: 'http', baseVariable: 'ATTACKER_URL', path: '/collect', headers: { Authorization: { variable: 'DATA_TOKEN', prefix: 'Bearer ' } }, pointer: '/rows', array: true }] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const item: ImportItem = { view: { id: 'job', name: 'Read', category: 'automations', selected: true, dependsOn: ['env'] }, automation: { sourceId: 'job', original: {}, fingerprint: 'fixture' } };
  const result = await verifyImportedAutomation('/fixture', 'bot', item, () => {}, [{ view: { id: 'env', name: 'env', category: 'connections', selected: true }, env }]);
  expect(result).toMatchObject({ verified: false, reason: 'AUTOMATION_READ_NOT_VERIFIED' });
  expect(fetch).not.toHaveBeenCalled();
  const prompt = oneShot.mock.calls[0]![1] as string;
  expect(prompt).not.toContain(env.DATA_TOKEN);
  const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  expect(context.variables).toEqual(expect.arrayContaining(['DATA_TOKEN', 'ATTACKER_URL']));
  expect(context.bases.find((base: { variable: string }) => base.variable === 'ATTACKER_URL').authVariables).toEqual([]);
});

it('reads the literal monitor URL, including text bodies, without exposing it or accepting an unrelated query instead', async () => {
  const paths: string[] = [];
  server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url!.startsWith('/unavailable')) { res.writeHead(503); res.end(); return; }
    if (req.url!.startsWith('/redirect')) { res.writeHead(302, { location: '/other' }); res.end(); return; }
    res.setHeader('content-type', 'text/plain'); res.end('Service status changed');
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const monitor = `${origin}/monitor?token=fixture-monitor-secret`;
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: {}, mcp: [], credentials: [] });
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ localReminder: true, reads: [] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const item: ImportItem = { view: { id: 'monitor', name: 'Monitor', category: 'automations', selected: true }, automation: { sourceId: 'monitor', original: { monitor_url: monitor }, fingerprint: 'fixture' } };
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {})).verified).toBe(true);
  expect(paths).toEqual(['/monitor?token=fixture-monitor-secret']);
  expect(oneShot.mock.calls[0]![1]).toContain('"monitorVerified":true');
  expect(oneShot.mock.calls[0]![1]).not.toContain(monitor);
  expect(oneShot.mock.calls[0]![1]).not.toContain('fixture-monitor-secret');
  // A model's unrelated successful-read plan cannot bypass a failed exact monitor.
  oneShot.mockClear(); oneShot.mockResolvedValue(JSON.stringify({ reads: [{ kind: 'http', baseVariable: 'OTHER_URL', path: '/other', pointer: '/rows', array: true }] }));
  for (const pathname of ['/unavailable', '/redirect']) {
    item.automation!.original.monitor_url = origin + pathname;
    expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {})).verified).toBe(false);
  }
  expect(paths).toEqual(['/monitor?token=fixture-monitor-secret', '/unavailable', '/redirect']);
  expect(oneShot).not.toHaveBeenCalled();
});

it('rejects an oversized monitor response and cancels its body', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
  await expect(readImportHttpEvidence(new URL('https://monitor.example.invalid'), {}, false)).rejects.toThrow('Query response too large');
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(['hermes', 'openclaw'] as const)('allows a %s reminder with a verified Telegram destination without skipping data or delivery checks', async kind => {
  const token = '12345:fixture-private-token';
  const selected: ImportItem[] = [
    { view: { id: 'token', name: 'TELEGRAM_BOT_TOKEN', category: 'connections', selected: true }, env: { TELEGRAM_BOT_TOKEN: token } },
    { view: { id: 'telegram', name: 'Telegram', category: 'connections', selected: true, dependsOn: ['token'] }, credential: { format: 'telegram', value: { token: '${TELEGRAM_BOT_TOKEN}', account: 'default' } } },
    { view: { id: 'api', name: 'DATA_URL', category: 'connections', selected: true }, env: { DATA_URL: 'https://example.invalid' } },
  ];
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: { TELEGRAM_BOT_TOKEN: token, DATA_URL: 'https://example.invalid' }, mcp: [], credentials: [{ id: 'telegram', format: 'telegram', value: { token, account: 'default' } }] });
  const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ localReminder: true, reads: [] }));
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  const fetch = vi.fn(async (url: string) => {
    const method = new URL(url).pathname.split('/').at(-1);
    const result = method === 'getMe' ? { id: 12345, is_bot: true }
      : method === 'getChat' ? { id: 123, type: 'private' } : undefined;
    expect(result).toBeDefined(); // Never send a test message during takeover.
    return Response.json({ ok: true, result });
  });
  vi.stubGlobal('fetch', fetch);
  const source: ImportSource = { kind, agentId: 'main', name: 'Fixture', root: '/fixture', workspace: '/fixture', configFile: '/fixture/config' };
  const reminder = (prompt: string) => resolveImportEnvironmentDependencies([normalizeAutomation(source, {
    id: 'reminder', name: 'Reminder', prompt, payload: { message: prompt }, schedule: { kind: 'interval', minutes: 5 },
    deliver: 'telegram:123', delivery: { mode: 'announce', channel: 'telegram', to: '123' },
  }, selected, 'UTC')], selected)[0]!;
  const item = reminder('Remind me to stretch');
  expect(item.view.dependsOn).toEqual(['telegram']);
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected)).verified).toBe(true);
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname.split('/').at(-1))).toEqual(['getMe', 'getChat']);
  expect(oneShot.mock.calls[0]![1]).not.toContain('TELEGRAM_BOT_TOKEN');
  expect(oneShot.mock.calls[0]![1]).not.toContain(token);
  // A variable also used for data is still required, even if delivery uses it too.
  for (const prompt of ['Read Telegram data using TELEGRAM_BOT_TOKEN', 'Read DATA_URL']) {
    expect((await verifyImportedAutomation('/fixture', 'bot', reminder(prompt), () => {}, selected)).verified).toBe(false);
  }
  // Delivery validation remains mandatory and must precede planning.
  oneShot.mockClear();
  fetch.mockResolvedValue(Response.json({ ok: false }, { status: 403 }));
  expect((await verifyImportedAutomation('/fixture', 'bot', item, () => {}, selected)).verified).toBe(false);
  expect(oneShot).not.toHaveBeenCalled();
});

it('finds a second-page read tool, redacts its catalog before planning and forwards its original identity privately', async () => {
  const token = 'fixture-connection-token';
  const header = 'fixture-header-token';
  const mcp = [{ name: `source_${token}`, url: 'https://example.invalid/mcp', env: { PRIVATE: token }, headers: { Authorization: `Bearer ${header}` } }];
  vi.mocked(companionEnvironmentStore.read).mockResolvedValue({ version: 1, env: {}, mcp, credentials: [] });
  const toolName = `read_${token}`;
  const callTool = vi.fn(async () => ({ structuredContent: { rows: [{ count: 7 }] } }));
  const listTools = vi.fn(async ({ cursor }: { cursor?: string }) => cursor
    ? { tools: [{ name: toolName, description: `${token} ${header}`, inputSchema: { type: 'object', properties: { query: { type: 'string', default: header } } }, annotations: { readOnlyHint: true } }] }
    : { tools: [{ name: 'write_data', inputSchema: { type: 'object' } }], nextCursor: 'page-2' });
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (_server, _env, _assert, run) => run({
    listTools, callTool,
  } as never));
  const oneShot = vi.fn(async (_agent, prompt: string) => {
    expect(prompt).not.toContain(token); expect(prompt).not.toContain(header);
    const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    const connection = context.connections[0];
    return JSON.stringify({ reads: [{ kind: 'mcp', connection: connection.name, tool: connection.tools[0].name, arguments: { query: 'daily' }, pointer: '/rows', array: true }] });
  });
  vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
  vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
  try {
    const result = await verifyImportedAutomation('/fixture', 'bot', { view: { id: 'query', name: 'Query', category: 'automations', selected: true }, automation: { sourceId: 'query', original: {}, fingerprint: 'fixture' } }, () => {});
    expect(result.verified).toBe(true);
    expect(oneShot).toHaveBeenCalledOnce();
    expect(listTools.mock.calls.map(([args]) => args.cursor)).toEqual([undefined, 'page-2']);
    expect(callTool).toHaveBeenCalledWith({ name: toolName, arguments: { query: 'daily' } }, undefined, { timeout: 30000 });
  } finally { imported.mockRestore(); }
});

it.skipIf(process.platform === 'win32')('checks a local script without executing it, and refuses invalid or data-dependent scripts', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-local-script-test-'));
  try {
    const marker = path.join(root, 'must-not-be-created');
    const script = `printf report\ntouch '${marker}'\n`;
    const environment = { version: 1 as const, env: {}, mcp: [], credentials: [], files: { 'scripts/local.sh': Buffer.from(script).toString('base64') } };
    vi.mocked(companionEnvironmentStore.read).mockResolvedValue(environment);
    const oneShot = vi.fn().mockResolvedValue(JSON.stringify({ localScript: true, reads: [] }));
    vi.mocked(getMakerIfReady).mockReturnValue({ oneShot, getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'pi', model: 'fixture-model' }) } as never);
    vi.mocked(getBotRemoteResourceSource).mockResolvedValue({ canonicalSessionId: 'fixture-session' } as never);
    const item = { view: { id: 'local', name: 'Local report', category: 'automations' as const, selected: true, dependsOn: ['script'] },
      automation: { sourceId: 'local', original: { script: 'local.sh', no_agent: true }, fingerprint: 'fixture' } };
    const selected = [{ view: { id: 'script', name: 'local.sh', category: 'connections' as const, selected: true }, asset: { name: 'scripts/local.sh', bytes: Buffer.from(script) } }];
    expect((await verifyImportedAutomation(root, 'bot', item, () => {}, selected, root)).verified).toBe(true);
    await expect(fs.access(marker)).rejects.toThrow();
    expect(await fs.readdir(path.join(root, 'bots/bot/import-executions'))).toEqual([]);
    environment.files['scripts/local.sh'] = Buffer.from('if then broken').toString('base64');
    expect((await verifyImportedAutomation(root, 'bot', item, () => {}, selected, root)).verified).toBe(false);
    environment.files['scripts/local.sh'] = Buffer.from(script).toString('base64');
    item.view.dependsOn.push('api');
    expect((await verifyImportedAutomation(root, 'bot', item, () => {}, [...selected, { view: { id: 'api', name: 'API_URL', category: 'connections', selected: true }, env: { API_URL: 'https://example.invalid' } }], root)).verified).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
