import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: vi.fn() }));
vi.mock('../../localDb/ipc/bots.js', () => ({ getBotRemoteResourceSource: vi.fn() }));
vi.mock('../runtime.js', () => ({ companionEnvironmentStore: { read: vi.fn() } }));
import { getMakerIfReady } from '../../maker-host/index.js';
import { getBotRemoteResourceSource } from '../../localDb/ipc/bots.js';
import { companionEnvironmentStore } from '../runtime.js';
import { matchesReadEvidence, readImportHttpEvidence, verifyImportedAutomation } from '../verification.js';
let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); }); });
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
