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
  writeProfile: vi.fn(), importDocument: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => h.root } }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => h.root, ownerScopedUserDataPath: () => h.root, getActiveAppSession: () => ({ dataOwnerId: 'fixture-owner' }), isAppSessionBoundaryPending: () => h.boundary }));
vi.mock('../../localDb/ipc/bots.js', () => ({
  listBotRemoteResourceSources: async () => [],
  getBotRemoteResourceSource: async () => { if (!h.created) throw new Error('[NOT_FOUND]'); return { canonicalSessionId: 'chat' }; },
  createBotProfile: async () => { h.created = true; }, createBotCanonicalSession: async () => ({ canonicalSessionId: 'chat' }),
  getBotMemoryService: () => ({ importDocument: h.importDocument }), reconcileBotProfileFolder: async () => {},
}));
vi.mock('../../localDb/ipc/botAvatarSelection.js', () => ({ validateBotAvatarBuffer: vi.fn(), decodeBotAvatarImage: vi.fn() }));
vi.mock('../../maker-ipc/botProfileFolder.js', () => ({ BOT_PROFILE_TEXT_MAX_BYTES: 100000, readBotProfileFolder: async () => ({ config: {} }), writeBotProfileFolder: h.writeProfile }));
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
import { listCompanionImportSources, previewCompanionImport, startCompanionImport, getCompanionImportResult, recoverCompanionImports, cancelCompanionImportsForDeletion } from '../host.js';
import { withBotProfileLocks } from '../../maker-ipc/botProfileLock.js';
import { assertImportedAutomationReady, prepareImportedAutomation } from '../automationRuntime.js';
import { decodeBotAvatarImage } from '../../localDb/ipc/botAvatarSelection.js';

beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-host-test-'));
  h.created = false; h.verified = false; h.sourceEnabled = true; h.failReadyWrite = false; h.boundary = false; h.routines = []; h.pause.mockClear(); h.sourceEnvironment = {};
  h.writeProfile.mockReset().mockResolvedValue(undefined); h.importDocument.mockReset().mockResolvedValue(undefined);
  vi.mocked(decodeBotAvatarImage).mockReset();
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

it.each(['', ' ', 'invalid-image'])('rejects avatar %j before persisting credentials and lets the same request be corrected', async avatarImageBase64 => {
  h.snapshot.items = [{ view: { id: 'env', name: 'Key', category: 'connections', selected: true }, env: { KEY: 'fixture-private-key' } }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const writes = vi.spyOn(h.store, 'write');
  vi.mocked(decodeBotAvatarImage).mockImplementation(() => { throw new Error('Invalid image'); });
  const selection = { requestId: 'fixture-avatar-12345', previewId: preview.id, name: 'Ada', entryIds: ['env'], takeover: false };
  await expect(startCompanionImport({ ...selection, avatarImageBase64 }, 'fixture')).rejects.toThrow('INVALID_SELECTION');
  expect(h.created).toBe(false);
  expect(writes).not.toHaveBeenCalled();
  expect(await getCompanionImportResult(selection.requestId)).toBeUndefined();
  expect(await fs.readdir(h.root)).toEqual([]);
  // The omitted-avatar path still uses ordinary companion creation defaults.
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.created).toBe(true);
});

it('masks all known credentials in preview labels without choosing conflicting accounts or changing the private snapshot', async () => {
  const secrets = ['fake-work-key', 'fake-personal-key', 'fake-unselected-key', 'fake-local-key', 'fake-header-key', 'fake-access-key', 'fake-refresh-key', 'fake/url+key'];
  const text = `status en us ${secrets.join(' ')} fake%2Furl%2Bkey`;
  h.snapshot.source.name = `Ada ${secrets[0]}`;
  h.snapshot.items = [
    { view: { id: 'work', name: 'Work', category: 'connections', selected: false, exclusiveWith: ['personal'] }, env: { OPENAI_API_KEY: secrets[0]! } },
    { view: { id: 'personal', name: 'Personal', category: 'connections', selected: false, exclusiveWith: ['work'] }, env: { OPENAI_API_KEY: secrets[1]! } },
    { view: { id: 'unselected', name: 'Other', category: 'connections', selected: false }, env: { OTHER_TOKEN: secrets[2]!, ENDPOINT: 'https://example.invalid/mcp?token=fake%2Furl%2Bkey', LANG: 'en', REGION: 'us' } },
    { view: { id: 'mcp', name: text, category: 'connections', selected: false, dependsOn: ['unselected'] }, mcp: { name: text, url: '${ENDPOINT}', env: { KEY: secrets[3]! }, headers: { Authorization: `Bearer ${secrets[4]}` } } },
    { view: { id: 'native', name: 'Auth', category: 'connections', selected: false }, credential: { format: 'native-auth', value: { access_token: secrets[5], nested: { refreshToken: secrets[6] } } } },
    { view: { id: 'skill', name: text, description: text, category: 'skills', selected: false } },
    { view: { id: 'task', name: text, description: text, category: 'automations', selected: false, enabled: true, issues: ['DELIVERY_NEEDS_ADAPTER'], dependsOn: ['mcp'] } },
  ];
  const original = structuredClone(h.snapshot);
  const [source] = await listCompanionImportSources('mobile-controller');
  const preview = await previewCompanionImport(source!.id, 'mobile-controller');
  for (const secret of [...secrets, 'fake%2Furl%2Bkey']) expect(JSON.stringify(preview)).not.toContain(secret);
  expect(preview.name).toMatch(/^Ada \[[^\]]+\]$/);
  expect(preview.source.name).toBe(preview.name);
  for (const entry of preview.entries) {
    const raw = original.items.find(item => item.view.id === entry.id)!.view;
    const { name: _name, description: _description, ...structure } = entry;
    const { name: _rawName, description: _rawDescription, ...rawStructure } = raw;
    expect(structure).toEqual(rawStructure);
  }
  expect(preview.entries.find(item => item.id === 'skill')?.description).toContain('status en us');
  expect(h.snapshot).toEqual(original);
  expect(h.created).toBe(false);
  expect(await fs.readdir(h.root)).toEqual([]);
  // A later explicit selection still imports the original usable credential.
  const requestId = 'preview-choice-12345';
  const result = await startCompanionImport({ requestId, previewId: preview.id, name: 'Ada', entryIds: ['work'], takeover: false }, 'mobile-controller');
  await vi.waitFor(async () => expect((await getCompanionImportResult(requestId))?.status).toBe('complete'));
  expect((await h.store.read(h.root, result.botId, () => {}))?.env).toEqual({ OPENAI_API_KEY: secrets[0] });
});

it('redacts selected credentials from profile and memory copies while retaining original documents and usable secrets privately', async () => {
  const secrets = ['fake-env-key', 'fake-local-key', 'fake-header-token', 'fake/url+key', 'fake-access-token', 'fake-refresh-token', '123:fake-telegram-token'];
  const text = `简短一点，带点幽默。status en us\n${secrets.join('\n')}\nfake-unselected-key`;
  const documents: ImportSnapshot['items'] = [
    { view: { id: 'soul', name: 'SOUL.md', category: 'personality', selected: true }, role: 'identity', text },
    { view: { id: 'user', name: 'USER.md', category: 'memory', selected: true }, role: 'user', text },
    { view: { id: 'instructions', name: 'HERMES.md', category: 'personality', selected: true }, role: 'instructions', text },
    { view: { id: 'reference', name: 'notes.md', category: 'memory', selected: true }, text },
    { view: { id: 'ordinary', name: 'ordinary.md', category: 'memory', selected: true }, text: 'Keep this paragraph exactly.\nSecond line.' },
  ];
  h.snapshot.items = [...documents,
    { view: { id: 'env', name: 'env', category: 'connections', selected: true }, env: { DATA_TOKEN: secrets[0]!, LANG: 'en', REGION: 'us' } },
    { view: { id: 'mcp', name: 'Data', category: 'connections', selected: true }, mcp: { name: 'Data', url: 'https://example.invalid/mcp?token=fake%2Furl%2Bkey', env: { KEY: secrets[1]!, REFERENCED: '${DATA_TOKEN}' }, headers: { Authorization: `Bearer ${secrets[2]}` } } },
    { view: { id: 'oauth', name: 'Auth', category: 'connections', selected: true }, credential: { format: 'native-auth', value: { value: { access_token: secrets[4], nested: { refreshToken: secrets[5] } } } } },
    { view: { id: 'telegram', name: 'Telegram', category: 'connections', selected: true }, credential: { format: 'telegram', value: { token: secrets[6], account: 'default' } } },
    { view: { id: 'excluded', name: 'Excluded', category: 'connections', selected: false }, env: { EXCLUDED: 'fake-unselected-key' } },
  ];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: h.snapshot.items.filter(item => item.view.selected).map(item => item.view.id), takeover: false };
  const result = await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  const profile = h.writeProfile.mock.calls[0]![2];
  const publicText = JSON.stringify([profile, h.importDocument.mock.calls]);
  for (const secret of secrets) expect(publicText).not.toContain(secret);
  for (const field of ['identitySource', 'userContextSource', 'systemPromptOverride']) {
    expect(profile[field]).toContain('简短一点，带点幽默。status en us');
    expect(profile[field]).toContain('fake-unselected-key');
  }
  expect(h.importDocument.mock.calls.find(call => call[1] === 'ordinary')?.[3]).toBe(documents[4]!.text);
  const stored = (await h.store.read(h.root, result.botId, () => {}))!;
  expect(stored.env.DATA_TOKEN).toBe(secrets[0]);
  expect(stored.env).not.toHaveProperty('EXCLUDED');
  expect(stored.mcp[0]?.env?.REFERENCED).toBe(secrets[0]);
  expect(stored.mcp[0]?.headers?.Authorization).toBe(`Bearer ${secrets[2]}`);
  expect(stored.documents).toEqual(Object.fromEntries(documents.map(item => [item.view.id, item.text])));
  expect(stored.pendingImport).toBeUndefined();
});

it.each(['absolute', 'relative'])('resolves a selected %s MCP cwd after environment choice without anchoring an absolute reference twice', async form => {
  const expected = path.join(h.root, 'server files');
  const value = form === 'absolute' ? expected : 'server files';
  h.snapshot.items = [
    { view: { id: 'cwd', name: 'MCP_DIR', category: 'connections', selected: true }, env: { MCP_DIR: value } },
    { view: { id: 'mcp', name: 'Data', category: 'connections', selected: true, dependsOn: ['cwd'] }, mcp: { name: 'Data', command: process.execPath, args: ['./server.cjs'], cwd: '${MCP_DIR}' } },
  ];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const requestId = 'fixture-cwd-123456';
  const result = await startCompanionImport({ requestId, previewId: preview.id, name: 'Ada', entryIds: ['cwd', 'mcp'], takeover: false }, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(requestId))?.status).toBe('complete'));
  const stored = (await h.store.read(h.root, result.botId, () => {}))!;
  expect(stored.mcp[0]?.cwd).toBe(expected);
  expect(stored.env.MCP_DIR).toBe(value);
  expect(h.snapshot.items[1]?.mcp?.cwd).toBe('${MCP_DIR}');
});

it('joins an in-flight credential write before deletion and durably blocks old-preview and restart retries', async () => {
  h.snapshot.items = [{ view: { id: 'env', name: 'Key', category: 'connections', selected: true }, env: { KEY: 'fake-import-secret' } }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['env'], takeover: false };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let writing = false;
  const write = h.store.write.bind(h.store);
  const writes = vi.spyOn(h.store, 'write').mockImplementation(async (...args) => {
    if (args[2].env.KEY) { writing = true; await blocked; }
    await write(...args);
  });
  const accepted = await startCompanionImport(selection, 'fixture');
  await vi.waitFor(() => expect(writing).toBe(true));
  expect(h.created).toBe(true);
  let deleted = false;
  // The real lifecycle service holds this same lock around preparation/DB deletion/cleanup.
  const deletion = withBotProfileLocks([accepted.botId], async () => {
    await cancelCompanionImportsForDeletion(accepted.botId);
    await h.store.stageRemoval(h.root, accepted.botId, () => {});
    h.created = false;
    await h.store.finishRemoval(h.root, accepted.botId, () => {});
    await fs.rm(path.join(h.root, 'bots', accepted.botId), { recursive: true, force: true });
    deleted = true;
  });
  try {
    expect((await getCompanionImportResult(selection.requestId))?.status).toBe('running');
    expect(deleted).toBe(false);
  } finally { release(); }
  await deletion;
  const count = writes.mock.calls.length;
  expect(await startCompanionImport(selection, 'fixture')).toMatchObject({ status: 'needs-attention', checks: expect.arrayContaining([{ entryId: 'import', status: 'needs-attention', message: 'IMPORT_CANCELLED' }]) });
  // Even an old unfinished handover phase cannot restart a cancelled receipt.
  const receiptFile = path.join(h.root, 'companion-imports', `${selection.requestId}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  receipt.routines.old = { id: 'old', phase: 'source-paused' };
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  await recoverCompanionImports();
  expect(h.created).toBe(false);
  expect(writes).toHaveBeenCalledTimes(count);
  expect(await h.store.read(h.root, accepted.botId, () => {})).toBeUndefined();
  expect((await getCompanionImportResult(selection.requestId))?.checks).toContainEqual({ entryId: 'import', status: 'needs-attention', message: 'IMPORT_CANCELLED' });
});

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
