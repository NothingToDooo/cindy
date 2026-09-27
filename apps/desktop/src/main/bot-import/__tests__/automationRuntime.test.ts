import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
