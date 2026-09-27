import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Routine, RoutineInput } from '@cindy/maker-scheduler';
import { createCompanionEnvironmentStore } from '../environment.js';
import type { ImportSnapshot } from '../types.js';

const h = vi.hoisted(() => ({ root: '', created: false, verified: false, sourceEnabled: true, failReadyWrite: false, boundary: false,
  snapshot: null as unknown as ImportSnapshot, store: null as unknown as ReturnType<typeof createCompanionEnvironmentStore>,
  routines: [] as Routine[], pause: vi.fn(), sourceEnvironment: {} as Record<string, string>,
}));
vi.mock('electron', () => ({ app: { getPath: () => h.root } }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => h.root, ownerScopedUserDataPath: () => h.root, getActiveAppSession: () => ({ dataOwnerId: 'fixture-owner' }), isAppSessionBoundaryPending: () => h.boundary }));
vi.mock('../../localDb/ipc/bots.js', () => ({
  listBotRemoteResourceSources: async () => [],
  getBotRemoteResourceSource: async () => { if (!h.created) throw new Error('[NOT_FOUND]'); return { canonicalSessionId: 'chat' }; },
  createBotProfile: async () => { h.created = true; }, createBotCanonicalSession: async () => ({ canonicalSessionId: 'chat' }),
  getBotMemoryService: () => ({ importDocument: async () => {} }), reconcileBotProfileFolder: async () => {},
}));
vi.mock('../../localDb/ipc/botAvatarSelection.js', () => ({ validateBotAvatarBuffer: vi.fn(), decodeBotAvatarImage: vi.fn() }));
vi.mock('../../maker-ipc/botProfileFolder.js', () => ({ BOT_PROFILE_TEXT_MAX_BYTES: 100000, readBotProfileFolder: async () => ({ config: {} }), writeBotProfileFolder: async () => {} }));
vi.mock('../../maker-ipc/botSkillStore.js', () => ({ importBotSkillFiles: vi.fn(), normalizeBotSkillSlug: (v: string) => v }));
vi.mock('../sources.js', () => ({ discoverImportSources: async () => [h.snapshot.source], inspectImportSource: async () => h.snapshot }));
vi.mock('../openclawCron.js', () => ({ readOpenClawCronDatabase: vi.fn() }));
vi.mock('../verification.js', () => ({ verifyImportedAutomation: async () => ({ verified: h.verified, reason: 'AUTOMATION_DATA_READ_FAILED' }) }));
vi.mock('../takeover.js', () => ({ changeSourceAutomationState: async (_source: unknown, _item: unknown, enabled: boolean, _readers: unknown, _owner: unknown, _resume: boolean, env: Record<string, string>) => { h.pause(enabled); h.sourceEnabled = enabled; h.sourceEnvironment = env; } }));
vi.mock('../runtime.js', () => ({ recoverCompanionEnvironmentRemovals: vi.fn(async () => {}), companionEnvironmentStore: {
  read: (...args: Parameters<typeof h.store.read>) => h.store.read(...args),
  write: (...args: Parameters<typeof h.store.write>) => h.store.write(...args),
  update: (...args: Parameters<typeof h.store.update>) => h.store.update(...args),
} }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: vi.fn() }));
vi.mock('../../routines/service.js', () => ({
  routineTools: {
    list: async () => structuredClone(h.routines),
    createOnce: async (botId: string, input: RoutineInput, id: string) => {
      // The real engine publishes creationId as the stable routine ID.
      expect((await h.store.read(h.root, botId, () => {}))?.automations?.[id]?.handover).toBe(h.sourceEnabled ? 'pending' : 'ready');
      const routine = { ...input, botId, id, revision: 1, createdAt: 1, updatedAt: 1 };
      h.routines.push(routine); return routine;
    },
  },
  getRoutineEngine: async () => ({ put: async (_botId: string, input: RoutineInput, id: string) => {
    expect(h.sourceEnabled).toBe(false);
    h.routines = h.routines.map(row => row.id === id ? { ...row, ...input, revision: row.revision + 1 } : row);
  } }),
}));
import { listCompanionImportSources, previewCompanionImport, startCompanionImport, getCompanionImportResult, recoverCompanionImports } from '../host.js';
import { assertImportedAutomationReady, prepareImportedAutomation } from '../automationRuntime.js';

beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-host-test-'));
  h.created = false; h.verified = false; h.sourceEnabled = true; h.failReadyWrite = false; h.boundary = false; h.routines = []; h.pause.mockClear(); h.sourceEnvironment = {};
  const values = new Map<string, string>();
  h.store = createCompanionEnvironmentStore({ read: key => values.get(key) ?? null, write: (key, value) => {
    if (h.failReadyWrite && Object.values<{ handover?: string }>(JSON.parse(value).automations ?? {}).some(binding => binding.handover === 'ready')) { h.failReadyWrite = false; return false; }
    values.set(key, value); return true;
  }, remove: key => values.delete(key) });
  h.snapshot = { source: { kind: 'hermes', agentId: 'default', name: 'Ada', root: h.root, workspace: h.root, configFile: path.join(h.root, 'config.yaml') }, fingerprint: 'fixture', items: [{
    view: { id: 'task', category: 'automations', name: 'Report', enabled: true, selected: true },
    automation: { sourceId: 'task', fingerprint: 'fixture', original: { enabled: true }, input: { name: 'Report', prompt: 'Read data', enabled: false, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }] } },
  }] };
});
afterEach(async () => { await fs.rm(h.root, { recursive: true, force: true }); });

it.each(['scan', 'same-request'] as const)('recovers an indexed checkpoint before receipt acknowledgement through %s', async recovery => {
  h.verified = true;
  h.snapshot.items.push(
    { view: { id: 'selected-env', name: 'Selected', category: 'connections', selected: true }, env: { SOURCE_KEY: 'fake-selected-credential' } },
    { view: { id: 'excluded-env', name: 'Excluded', category: 'connections', selected: false }, env: { UNUSED_KEY: 'fake-excluded-credential' } },
  );
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task', 'selected-env'], takeover: true };
  const receiptFile = path.join(h.root, 'companion-imports', `${selection.requestId}.json`);
  const write = h.store.write.bind(h.store);
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  let checkpointWritten = false; let botId = ''; let acknowledged = false;
  vi.spyOn(h.store, 'write').mockImplementationOnce(async (...args) => {
    // A restart can discover the request even before the checkpoint flag is saved.
    const index = await fs.readFile(receiptFile, 'utf8');
    expect(index).not.toContain('fake-selected-credential'); expect(index).not.toContain('fake-excluded-credential');
    expect(JSON.parse(index)).toMatchObject({ result: { requestId: selection.requestId, status: 'running', botId: args[1] } });
    expect(JSON.parse(index).checkpointSaved).not.toBe(true);
    await write(...args); botId = args[1]; checkpointWritten = true;
    await pause; h.boundary = true; // Simulates stopping before the acknowledgement write.
  });
  const pending = startCompanionImport(selection, 'fixture').then(value => { acknowledged = true; return value; }).catch(error => error);
  try {
    await vi.waitFor(() => expect(checkpointWritten).toBe(true));
    // Several acknowledgement polling ticks must not accept the index alone.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(acknowledged).toBe(false); expect(h.created).toBe(false);
    const stored = (await h.store.read(h.root, botId, () => {}))!.pendingImport!;
    expect(stored.snapshotJson).toContain('fake-selected-credential');
    expect(stored.snapshotJson).not.toContain('fake-excluded-credential');
  } finally { release(); }
  expect(await pending).toMatchObject({ code: 'OWNER_CHANGED' });
  h.boundary = false;
  // A new controller cannot use the old in-memory preview; both paths use the checkpoint.
  if (recovery === 'scan') await recoverCompanionImports();
  else await startCompanionImport(selection, 'restarted-controller');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.routines).toHaveLength(1); expect(h.routines[0]?.enabled).toBe(true);
  expect(h.pause).toHaveBeenCalledExactlyOnceWith(false);
  expect((await h.store.read(h.root, botId, () => {}))?.env).toEqual({ SOURCE_KEY: 'fake-selected-credential' });
  expect(h.sourceEnvironment).toEqual({ SOURCE_KEY: 'fake-selected-credential' });
});

it('persists a failed handover, blocks use, and unlocks the same routine only after a successful retry', async () => {
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('needs-attention'));
  const routine = h.routines[0]!;
  expect(routine.enabled).toBe(false); expect(h.sourceEnabled).toBe(true); expect(h.pause).not.toHaveBeenCalled();
  await expect(assertImportedAutomationReady(h.root, routine.botId, routine.id, () => {})).rejects.toThrow('AUTOMATION_HANDOVER_REQUIRED');
  expect(await prepareImportedAutomation(h.root, { ...routine, enabled: true }, 'run', new AbortController().signal, () => {})).toMatchObject({ deferred: true });
  h.verified = true;
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.routines).toHaveLength(1); expect(h.routines[0]?.enabled).toBe(true);
  expect(h.pause).toHaveBeenCalledExactlyOnceWith(false);
  await expect(assertImportedAutomationReady(h.root, routine.botId, routine.id, () => {})).resolves.toBeUndefined();
  // Earlier successful receipts repair missing state without rerunning a takeover.
  await h.store.update(h.root, routine.botId, () => {}, env => { delete env.automations![routine.id]!.handover; });
  await getCompanionImportResult(selection.requestId);
  await expect(assertImportedAutomationReady(h.root, routine.botId, routine.id, () => {})).resolves.toBeUndefined();
  expect(h.pause).toHaveBeenCalledTimes(1);
  // Simulate a crash after the ready marker but before the outer receipt save.
  await h.store.update(h.root, routine.botId, () => {}, env => { env.pendingImport = { selection, snapshotJson: JSON.stringify(h.snapshot) }; });
  const receiptFile = path.join(h.root, 'companion-imports', `${selection.requestId}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  receipt.result.status = 'running'; receipt.routines.task.phase = 'source-paused';
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  h.routines[0]!.name = 'Edited after takeover';
  await getCompanionImportResult(selection.requestId);
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.routines[0]?.name).toBe('Edited after takeover');
  expect(h.pause).toHaveBeenCalledTimes(1);
});

it.each([false, true])('keeps a copied routine paused and only allows future enable if the source was already paused (%s)', async sourcePaused => {
  h.sourceEnabled = !sourcePaused;
  h.snapshot.items[0]!.view.enabled = !sourcePaused;
  h.snapshot.items[0]!.automation!.original.enabled = !sourcePaused;
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: false };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  const routine = h.routines[0]!;
  expect(routine.enabled).toBe(false); expect(h.pause).not.toHaveBeenCalled();
  const guard = assertImportedAutomationReady(h.root, routine.botId, routine.id, () => {});
  if (sourcePaused) await expect(guard).resolves.toBeUndefined();
  else await expect(guard).rejects.toThrow('AUTOMATION_HANDOVER_REQUIRED');
});

it('keeps the source paused and execution deferred when the ready marker write fails after activation', async () => {
  h.verified = true; h.failReadyWrite = true;
  // The one-time deadline passes while the durable host recovery waits to retry.
  h.snapshot.items[0]!.automation!.input!.triggers = [{ id: 'once', kind: 'once', at: Date.now() + 1000 }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.checks.some(check => check.message === 'TARGET_HANDOVER_UNCERTAIN')).toBe(true));
  const routine = h.routines[0]!;
  expect(routine.enabled).toBe(true); expect(h.sourceEnabled).toBe(false);
  expect(await prepareImportedAutomation(h.root, routine, 'run', new AbortController().signal, () => {})).toMatchObject({ deferred: true });
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'), { timeout: 8000 });
  await expect(assertImportedAutomationReady(h.root, routine.botId, routine.id, () => {})).resolves.toBeUndefined();
  expect(h.pause).toHaveBeenCalledExactlyOnceWith(false);
}, 10000);
