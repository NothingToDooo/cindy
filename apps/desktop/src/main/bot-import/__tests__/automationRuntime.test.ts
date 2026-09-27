import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Routine } from '@cindy/maker-scheduler';
import { createCompanionEnvironmentStore } from '../environment.js';

const shared = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof createCompanionEnvironmentStore>, message: vi.fn() }));
vi.mock('../runtime.js', () => ({ companionEnvironmentStore: { read: (...args: Parameters<typeof shared.store.read>) => shared.store.read(...args), update: (...args: Parameters<typeof shared.store.update>) => shared.store.update(...args) } }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: shared.message }));
import { prepareImportedAutomation, finishImportedAutomation } from '../automationRuntime.js';
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-runtime-test-'));
  const values = new Map<string, string>();
  shared.store = createCompanionEnvironmentStore({ read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); return true; }, remove: key => { values.delete(key); return true; } });
  shared.message.mockReset().mockResolvedValue({});
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it.skipIf(process.platform === 'win32')('runs a copied script after the source is gone, with private env, once per durable run', async () => {
  const script = 'test "$DATA_TOKEN" = "fixture-token" || exit 1\nprintf "data read succeeded"\n';
  await shared.store.write(root, 'bot', { version: 1, env: { DATA_TOKEN: 'fixture-token' }, mcp: [], credentials: [], files: { 'scripts/report.sh': Buffer.from(script).toString('base64') }, automations: {
    routine: { kind: 'hermes', original: { id: 'original', script: 'report.sh', no_agent: true, repeat: { times: 1, completed: 0 } }, sourceRoot: path.join(root, 'source-does-not-exist'), deliveries: [] },
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
