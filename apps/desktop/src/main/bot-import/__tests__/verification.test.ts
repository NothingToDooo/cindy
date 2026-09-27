import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: vi.fn() }));
vi.mock('../../localDb/ipc/bots.js', () => ({ getBotRemoteResourceSource: vi.fn() }));
vi.mock('../runtime.js', () => ({ companionEnvironmentStore: {} }));
import { matchesReadEvidence, readImportHttpEvidence } from '../verification.js';
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
