import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import type { Routine } from '@cindy/maker-scheduler';
import { createCompanionEnvironmentStore } from '../environment.js';

const shared = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof createCompanionEnvironmentStore>, message: vi.fn() }));
vi.mock('../runtime.js', () => ({ companionEnvironmentStore: { read: (...args: Parameters<typeof shared.store.read>) => shared.store.read(...args), update: (...args: Parameters<typeof shared.store.update>) => shared.store.update(...args) } }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: shared.message }));
import { assertImportedAutomationReady, prepareImportedAutomation, finishImportedAutomation } from '../automationRuntime.js';
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-runtime-test-'));
  const values = new Map<string, string>();
  shared.store = createCompanionEnvironmentStore({ read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); return true; }, remove: key => { values.delete(key); return true; } });
  shared.message.mockReset().mockResolvedValue({});
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
it('uses the original monitor URL but masks echoed path/query credentials, previous output and legacy retry caches', async () => {
  const requests: string[] = [];
  const endpoint = createServer((req, res) => {
    requests.push(req.url!);
    res.end(`Count: 7\n${req.url}\nfake-path-secret\nfake/query+secret`);
  });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/fake-path-secret?token=fake%2Fquery%2Bsecret`;
  const routine: Routine = { id: 'routine', botId: 'bot', name: 'Monitor', prompt: `Monitor ${url}`, enabled: true, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }], revision: 1, createdAt: 1, updatedAt: 1 };
  const signal = new AbortController().signal;
  try {
    await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
      routine: { kind: 'hermes', handover: 'ready', original: { monitor_url: url }, sourceRoot: root, monitorOutput: `Old ${url} fake/query+secret` },
    } }, () => {});
    const prepared = (await prepareImportedAutomation(root, routine, 'run', signal, () => {}))!;
    expect(requests).toEqual(['/fake-path-secret?token=fake%2Fquery%2Bsecret']);
    expect(prepared.prompt).toContain('Count: 7');
    const stored = (await shared.store.read(root, 'bot', () => {}))!;
    expect(stored.automations!.routine!.original.monitor_url).toBe(url);
    for (const value of [url, 'fake-path-secret', 'fake/query+secret', 'fake%2Fquery%2Bsecret']) {
      expect(JSON.stringify(prepared)).not.toContain(value);
      expect(JSON.stringify(stored.automations!.routine!.prepared)).not.toContain(value);
    }
    await finishImportedAutomation(root, routine, 'chat', 'run', prepared.prompt, true, signal, () => {});
    expect(shared.message.mock.calls[0]![1].content).toBe(prepared.prompt);
    expect((await prepareImportedAutomation(root, routine, 'next-run', signal, () => {}))?.skipped).toBe(true);
    // A persisted result written by an older build is sanitized even on the fast retry path.
    await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.prepared = { runId: 'legacy', prompt: url, direct: 'fake/query+secret', monitorOutput: 'fake-path-secret' }; });
    const calls = requests.length;
    const retry = await prepareImportedAutomation(root, routine, 'legacy', signal, () => {});
    for (const value of [url, 'fake-path-secret', 'fake/query+secret']) expect(JSON.stringify(retry)).not.toContain(value);
    expect(requests).toHaveLength(calls);
    await finishImportedAutomation(root, routine, 'chat', 'legacy', 'fake/query+secret', true, signal, () => {});
    expect(JSON.stringify(shared.message.mock.calls)).not.toContain('fake/query+secret');
  } finally { endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve())); }
});
it.skipIf(process.platform === 'win32')('runs a copied script after the source is gone, with private env, once per durable run', async () => {
  vi.stubEnv('CINDY_UNRELATED_TEST_SECRET', 'fixture-launch-secret');
  vi.stubEnv('HTTPS_PROXY', 'http://fixture-user:fixture-password@example.invalid');
  const script = 'test "$DATA_TOKEN" = "fixture-token" || exit 1\ntest -z "$CINDY_UNRELATED_TEST_SECRET" || exit 2\ntest -z "$HTTPS_PROXY" || exit 3\nprintf "data read succeeded"\n';
  await shared.store.write(root, 'bot', { version: 1, env: { DATA_TOKEN: 'fixture-token' }, mcp: [], credentials: [], files: { 'scripts/report.sh': Buffer.from(script).toString('base64') }, automations: {
    routine: { kind: 'hermes', handover: 'ready', original: { id: 'original', script: 'report.sh', no_agent: true, repeat: { times: 1, completed: 0 } }, sourceRoot: path.join(root, 'source-does-not-exist'), deliveries: [] },
  } }, () => {});
  const routine: Routine = { id: 'routine', botId: 'bot', name: 'Report', prompt: 'Run report', enabled: true, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }], revision: 1, createdAt: 1, updatedAt: 1 };
  const signal = new AbortController().signal;
  const result = await prepareImportedAutomation(root, routine, 'run-1', signal, () => {});
  expect(result?.direct).toBe('data read succeeded');
  expect(await prepareImportedAutomation(root, routine, 'run-1', signal, () => {})).toEqual(result);
  await finishImportedAutomation(root, routine, 'main-chat', 'run-1', result!.direct!, true, signal, () => {});
  expect(shared.message).toHaveBeenCalledWith('main-chat', expect.objectContaining({ clientId: 'imported-routine:run-1', content: 'data read succeeded' }));
  expect((await prepareImportedAutomation(root, routine, 'run-2', signal, () => {}))?.skipped).toBe(true);
  expect(await fs.readdir(path.join(root, 'bots/bot/import-executions'))).toEqual([]);
});

it.each(['pending', undefined] as const)('blocks management and defers execution until the persisted %s handover completes', async handover => {
  const routine: Routine = { id: 'routine', botId: 'bot', name: 'Report', prompt: 'Read data', enabled: true, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }], revision: 1, createdAt: 1, updatedAt: 1 };
  await shared.store.write(root, 'bot', { version: 1, env: {}, mcp: [], credentials: [], automations: {
    routine: { kind: 'hermes', handover, original: { enabled: true }, sourceRoot: root, prepared: { runId: 'run', prompt: 'cached' } },
  } }, () => {});
  await expect(assertImportedAutomationReady(root, 'bot', 'routine', () => {})).rejects.toThrow('AUTOMATION_HANDOVER_REQUIRED');
  const signal = new AbortController().signal;
  expect(await prepareImportedAutomation(root, routine, 'run', signal, () => {})).toMatchObject({ deferred: true });
  expect(shared.message).not.toHaveBeenCalled();
  await expect(fs.access(path.join(root, 'bots/bot/import-executions'))).rejects.toThrow();
  await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.handover = 'ready'; });
  await expect(assertImportedAutomationReady(root, 'bot', 'routine', () => {})).resolves.toBeUndefined();
  expect(await prepareImportedAutomation(root, routine, 'run', signal, () => {})).toEqual({ runId: 'run', prompt: 'cached' });
  // Static adapter/dependency failures remain blocked even after a ready marker.
  await shared.store.update(root, 'bot', () => {}, env => { env.automations!.routine!.issues = ['AUTOMATION_DEPENDENCY_NOT_SELECTED']; });
  await expect(assertImportedAutomationReady(root, 'bot', 'routine', () => {})).rejects.toThrow('AUTOMATION_DEPENDENCY_NOT_SELECTED');
});
