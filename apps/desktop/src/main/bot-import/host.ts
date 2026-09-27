import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import sharp from 'sharp';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { parseRoutineInput } from '@cindy/maker-scheduler';
import { normalizeBotName } from '../../shared/botCreation.js';
import { listBotRemoteResourceSources } from '../localDb/ipc/bots.js';
import { validateBotAvatarBuffer, decodeBotAvatarImage } from '../localDb/ipc/botAvatarSelection.js';
import type { CompanionImportPreview, CompanionImportResult, CompanionImportSelection, CompanionImportSource } from '@cindy/maker-shared/companion-import';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { createBotCanonicalSession, createBotProfile, getBotMemoryService, getBotRemoteResourceSource, reconcileBotProfileFolder } from '../localDb/ipc/bots.js';
import { readBotProfileFolder, writeBotProfileFolder, BOT_PROFILE_TEXT_MAX_BYTES } from '../maker-ipc/botProfileFolder.js';
import { importBotSkillFiles, normalizeBotSkillSlug } from '../maker-ipc/botSkillStore.js';
import { getRoutineEngine, routineTools } from '../routines/service.js';
import { discoverImportSources, inspectImportSource, type SourceReaderDeps } from './sources.js';
import { readOpenClawCronDatabase } from './openclawCron.js';
import { companionEnvironmentStore } from './runtime.js';
import { fingerprint } from './files.js';
import { transferCompanion, validateImportSelection, type ImportReceipt, type TransferDeps } from './transfer.js';
import { CompanionImportError, type ImportSnapshot, type ImportSource } from './types.js';
import { changeSourceAutomationState } from './takeover.js';
import { verifyImportedAutomation } from './verification.js';

interface Owned<T> { owner: string; controller: string; value: T; createdAt: number }
const sources = new Map<string, Owned<ImportSource>>();
const previews = new Map<string, Owned<ImportSnapshot>>();
const jobs = new Map<string, Promise<CompanionImportResult>>();
const TTL = 30 * 60_000;
function owner() {
  const scope = activeOwnerScopeKey();
  const root = ownerScopedUserDataPath();
  const assert = () => {
    if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending() || scope !== activeOwnerScopeKey()) throw new CompanionImportError('OWNER_CHANGED');
  };
  assert();
  return { scope, root, assert };
}
const readers = (): SourceReaderDeps => ({ home: app.getPath('home'), env: process.env, readCronDatabase: readOpenClawCronDatabase });

function prune<T>(entries: Map<string, Owned<T>>) {
  for (const [key, entry] of entries) if (Date.now() - entry.createdAt > TTL || entry.owner !== activeOwnerScopeKey()) entries.delete(key);
}
function owned<T>(entries: Map<string, Owned<T>>, id: string, controller: string): T {
  prune(entries);
  const result = entries.get(id);
  if (!result || result.owner !== activeOwnerScopeKey() || result.controller !== controller) throw new CompanionImportError('PREVIEW_EXPIRED');
  return result.value;
}

export async function listCompanionImportSources(controller: string): Promise<CompanionImportSource[]> {
  const scope = owner();
  const found = await discoverImportSources(readers()); scope.assert();
  prune(sources);
  return found.map(source => {
    const id = randomUUID();
    sources.set(id, { owner: scope.scope, controller, value: source, createdAt: Date.now() });
    return { id, kind: source.kind, name: source.name };
  });
}

export async function previewCompanionImport(sourceId: string, controller: string): Promise<CompanionImportPreview> {
  const scope = owner();
  const source = owned(sources, sourceId, controller);
  const snapshot = await inspectImportSource(source, readers()); scope.assert();
  if (snapshot.avatarImageBase64) {
    const buffer = Buffer.from(snapshot.avatarImageBase64, 'base64');
    validateBotAvatarBuffer(buffer);
    snapshot.avatarImageBase64 = (await sharp(buffer, { limitInputPixels: 40_000_000 }).resize(256, 256, { fit: 'cover' }).jpeg({ quality: 65 }).toBuffer()).toString('base64');
    scope.assert();
  }
  const id = randomUUID();
  prune(previews);
  previews.set(id, { owner: scope.scope, controller, value: snapshot, createdAt: Date.now() });
  return { id, source: { id: sourceId, kind: source.kind, name: source.name }, name: source.name,
    ...(snapshot.avatarImageBase64 ? { avatarImageBase64: snapshot.avatarImageBase64 } : {}), entries: snapshot.items.map(item => item.view) };
}

function receiptFile(root: string, requestId: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) throw new CompanionImportError('INVALID_REQUEST');
  return path.join(root, 'companion-imports', `${requestId}.json`);
}

/** Reconcile only previously authorized, unfinished requests in the currently signed-in account. */
export async function recoverCompanionImports(): Promise<void> {
  const scope = owner();
  let files: string[];
  try { files = await fs.readdir(path.join(scope.root, 'companion-imports')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of files.filter(name => /^[A-Za-z0-9_-]{16,100}\.json$/.test(name))) {
    scope.assert();
    try { await getCompanionImportResult(name.slice(0, -5)); } catch { scope.assert(); }
  }
}
async function readReceipt(root: string, requestId: string): Promise<ImportReceipt | undefined> {
  const text = readAtomicFileSync(receiptFile(root, requestId));
  return text ? JSON.parse(text) as ImportReceipt : undefined;
}
async function saveReceipt(root: string, receipt: ImportReceipt) {
  const file = receiptFile(root, receipt.result.requestId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(file, JSON.stringify(receipt));
}

export async function getCompanionImportResult(requestId: string): Promise<CompanionImportResult | undefined> {
  const scope = owner();
  const receipt = await readReceipt(scope.root, requestId); scope.assert();
  // Upgrade earlier import bindings only from a durable successful receipt.
  // Failed/skipped active-source handovers must never become executable here.
  if (receipt) {
    const environment = await companionEnvironmentStore.read(scope.root, receipt.result.botId, scope.assert);
    const ready = Object.entries(receipt.routines).flatMap(([entryId, routine]) => {
      const binding = environment?.automations?.[routine.id];
      const status = receipt.result.checks.find(check => check.entryId === entryId)?.status;
      return binding && binding.handover === undefined && routine.phase === 'complete'
        && (status === 'taken-over' || status === 'paused' && (binding.original.enabled === false || binding.original.state === 'paused')) ? [routine.id] : [];
    });
    if (ready.length) await companionEnvironmentStore.update(scope.root, receipt.result.botId, scope.assert, env => {
      for (const id of ready) if (env.automations?.[id]?.handover === undefined) env.automations![id]!.handover = 'ready';
    });
  }
  if (receipt && (receipt.result.status === 'running' || Object.values(receipt.routines).some(item => item.phase === 'pausing-source' || item.phase === 'source-paused')) && !jobs.has(`${scope.scope}:${requestId}`)) {
    const environment = await companionEnvironmentStore.read(scope.root, receipt.result.botId, scope.assert);
    const pending = environment?.pendingImport;
    if (pending && pending.selection.requestId === requestId) {
      const snapshot = JSON.parse(pending.snapshotJson, (_key, value: unknown) => {
        const record = value as { type?: string; data?: unknown } | null;
        return record?.type === 'Buffer' && Array.isArray(record.data) ? Buffer.from(record.data) : value;
      }) as ImportSnapshot;
      const controller = `recovery:${scope.scope}`;
      previews.set(pending.selection.previewId, { owner: scope.scope, controller, value: snapshot, createdAt: Date.now() });
      return startCompanionImport(pending.selection, controller);
    }
    receipt.result.status = 'needs-attention';
    receipt.result.checks.push({ entryId: 'import', status: 'needs-attention', message: 'IMPORT_INTERRUPTED' });
    await saveReceipt(scope.root, receipt);
  }
  return receipt?.result;
}

/** Main-owned work survives closing the import dialog. Repeated request IDs join the same work. */
export async function startCompanionImport(selection: CompanionImportSelection, controller: string): Promise<CompanionImportResult> {
  const scope = owner();
  if (!selection || typeof selection.previewId !== 'string') throw new CompanionImportError('INVALID_SELECTION');
  let snapshot: ImportSnapshot;
  try { snapshot = owned(previews, selection.previewId, controller); }
  catch (error) {
    if (!(error instanceof CompanionImportError) || error.code !== 'PREVIEW_EXPIRED') throw error;
    const receipt = await readReceipt(scope.root, selection.requestId); scope.assert();
    const pending = receipt ? (await companionEnvironmentStore.read(scope.root, receipt.result.botId, scope.assert))?.pendingImport : undefined;
    const intentKey = (value: CompanionImportSelection) => fingerprint({ ...value, entryIds: [...value.entryIds].sort() });
    if (!pending || !Array.isArray(selection.entryIds) || intentKey(pending.selection) !== intentKey(selection)) throw error;
    snapshot = JSON.parse(pending.snapshotJson, (_key, value: unknown) => {
      const record = value as { type?: string; data?: unknown } | null;
      return record?.type === 'Buffer' && Array.isArray(record.data) ? Buffer.from(record.data) : value;
    }) as ImportSnapshot;
  }
  const selected = validateImportSelection(selection, snapshot);
  for (const role of ['identity', 'user', 'instructions'] as const) {
    const text = selected.filter(item => item.role === role).map(item => item.text).join('\n\n');
    if (Buffer.byteLength(text, 'utf8') > BOT_PROFILE_TEXT_MAX_BYTES) throw new CompanionImportError('PROFILE_TEXT_TOO_LARGE');
  }
  const prior = await readReceipt(scope.root, selection.requestId); scope.assert();
  if (!prior) {
    const profiles = await listBotRemoteResourceSources(); scope.assert();
    if (profiles.some(profile => profile.status !== 'archived' && normalizeBotName(profile.name) === normalizeBotName(selection.name))) throw new CompanionImportError('IMPORT_NAME_EXISTS');
    if (selection.avatarImageBase64) {
      try { decodeBotAvatarImage(selection.avatarImageBase64); } catch { throw new CompanionImportError('INVALID_SELECTION'); }
    }
  }
  const jobKey = `${scope.scope}:${selection.requestId}`;
  const running = jobs.get(jobKey);
  if (running) return accepted(running, scope.root, selection.requestId);
  const transferDeps: TransferDeps = {
    assertOwner: scope.assert,
    readReceipt: requestId => readReceipt(scope.root, requestId),
    saveReceipt: receipt => saveReceipt(scope.root, receipt),
    async createCompanion(botId, input) {
      try { await getBotRemoteResourceSource(botId); scope.assert(); return; }
      catch (error) { if (!(error instanceof Error) || !error.message.includes('[NOT_FOUND]')) throw error; }
      await createBotProfile({ id: botId, name: input.name, description: '', avatarImageBase64: input.avatarImageBase64, prepareInvitation: false });
    },
    async importItem(botId, item) {
      if (item.view.category === 'skills') {
        const original = path.basename(item.sourceDirectory ?? item.view.name);
        const normalized = normalizeBotSkillSlug(original);
        const slug = normalized === original ? original : `${normalized?.slice(0, 35) || 'import'}-${fingerprint(item.view.id).slice(0, 8)}`;
        await importBotSkillFiles(scope.root, botId, slug, item.files ?? [], scope.assert);
      } else if (item.text && item.view.category === 'memory') {
        await getBotMemoryService().importDocument(botId, item.view.id, item.view.name, item.text, item.role === 'user' ? 'user' : 'reference');
      }
    },
    async saveCheckpoint(botId, items) {
      const previous = await companionEnvironmentStore.read(scope.root, botId, scope.assert);
      const pendingImport = { selection, snapshotJson: JSON.stringify({ ...snapshot, avatarImageBase64: selection.avatarImageBase64, items }) };
      if (previous) await companionEnvironmentStore.update(scope.root, botId, scope.assert, environment => { environment.pendingImport = pendingImport; });
      else await companionEnvironmentStore.write(scope.root, botId, { version: 1, env: {}, mcp: [], credentials: [], pendingImport }, scope.assert);
    },
    async saveEnvironment(botId, items) {
      const previous = await companionEnvironmentStore.read(scope.root, botId, scope.assert);
      const chosen = new Set(items.map(item => item.view.id));
      const env: Record<string, string> = Object.assign({}, ...items.map(item => item.env ?? {}));
      const resolveReferences = (value: unknown): unknown => {
        if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
          if (!Object.hasOwn(env, key)) throw new CompanionImportError('AUTOMATION_DEPENDENCY_NOT_SELECTED');
          return env[key]!;
        });
        if (Array.isArray(value)) return value.map(resolveReferences);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveReferences(child)]));
        return value;
      };
      await companionEnvironmentStore.write(scope.root, botId, { version: 1,
        env,
        mcp: items.flatMap(item => item.mcp && !item.view.dependsOn?.some(id => !chosen.has(id)) && !item.view.issues?.length ? [resolveReferences(item.mcp) as NonNullable<typeof item.mcp>] : []),
        credentials: items.flatMap(item => item.credential && !item.view.dependsOn?.some(id => !chosen.has(id)) && (!item.view.issues?.length || item.credential.format !== 'telegram') ? [{ id: item.view.id, ...item.credential, ...(item.credential.format === 'telegram' ? { value: resolveReferences(item.credential.value) } : {}) }] : []),
        files: Object.fromEntries(items.flatMap(item => item.asset ? [[item.asset.name, item.asset.bytes.toString('base64')]] : [])),
        sourceAutomations: items.flatMap(item => item.automation ? [{ entryId: item.view.id, kind: snapshot.source.kind, original: item.automation.original }] : []),
        pendingImport: { selection, snapshotJson: JSON.stringify({ ...snapshot, avatarImageBase64: selection.avatarImageBase64, items }) },
        automations: previous?.automations ?? {},
      }, scope.assert);
      const roleText = (role: 'identity' | 'user' | 'instructions') => items.filter(item => item.role === role).map(item => item.text).join('\n\n');
      const folder = await readBotProfileFolder(scope.root, botId); scope.assert();
      await writeBotProfileFolder(scope.root, botId, {
        config: { ...folder.config, mcpMode: 'allowlist', mcpServers: [...new Set([
          ...(Array.isArray(folder.config.mcpServers) ? folder.config.mcpServers : []),
          ...(items.some(item => item.mcp || item.env) ? ['companion_connections'] : []),
        ])] },
        ...(roleText('identity') ? { identitySource: roleText('identity') } : {}),
        ...(roleText('user') ? { userContextSource: roleText('user') } : {}),
        ...(roleText('instructions') ? { systemPromptOverride: roleText('instructions') } : {}),
      }); scope.assert();
      await reconcileBotProfileFolder(botId); scope.assert();
    },
    async createConversation(botId) {
      const source = await getBotRemoteResourceSource(botId); scope.assert();
      if (source.canonicalSessionId) return source.canonicalSessionId;
      const result = await createBotCanonicalSession({ botId, expectedCanonicalSessionId: null, expectedProfileVersion: source.currentVersion });
      scope.assert(); return result.canonicalSessionId;
    },
    async createRoutine(botId, input, creationId, item) {
      if (!item.automation) throw new CompanionImportError('SOURCE_AUTOMATION_INVALID');
      // createOnce uses creationId as its persisted routine ID. Publish the guard
      // first so there is no editor-visible window without a handover binding.
      await companionEnvironmentStore.update(scope.root, botId, scope.assert, environment => {
        environment.automations ??= {};
        environment.automations[creationId] ??= { kind: snapshot.source.kind,
          handover: item.view.enabled ? 'pending' : 'ready',
          original: item.automation!.original, sourceRoot: snapshot.source.root, deliveries: item.automation!.deliveries,
          issues: [...(item.view.issues ?? []), ...(item.view.dependsOn?.some(id => !selection.entryIds.includes(id)) ? ['AUTOMATION_DEPENDENCY_NOT_SELECTED'] : [])] };
      });
      const routine = await routineTools.createOnce(botId, input, creationId); scope.assert();
      return routine.id;
    },
    verifyAutomation: (botId, item) => verifyImportedAutomation(scope.root, botId, item, scope.assert, selected, snapshot.source.root),
    pauseSource: (item, source, resumeInterruptedPause) => changeSourceAutomationState(source.source, item, false, readers(), scope.assert, resumeInterruptedPause),
    resumeSource: (item, source) => changeSourceAutomationState(source.source, item, true, readers(), scope.assert),
    async enableRoutine(botId, routineId, item) {
      const routine = (await routineTools.list(botId)).find(item => item.id === routineId); scope.assert();
      if (!routine) throw new CompanionImportError('AUTOMATION_NOT_FOUND');
      const binding = (await companionEnvironmentStore.read(scope.root, botId, scope.assert))?.automations?.[routineId];
      // The private activation committed even if its outer receipt was lost.
      // Preserve edits made after that success instead of restoring the source.
      if (binding?.handover === 'ready') return;
      if (!item.automation?.input || JSON.stringify(parseRoutineInput({ ...routine, enabled: false })) !== JSON.stringify(parseRoutineInput({ ...item.automation.input, enabled: false }))) {
        throw new CompanionImportError(routine.enabled ? 'TARGET_HANDOVER_UNCERTAIN' : 'TARGET_AUTOMATION_CHANGED');
      }
      const expected = parseRoutineInput({ ...routine, enabled: true });
      if (!routine.enabled && expected.triggers.some(trigger => trigger.kind === 'once' && trigger.at <= Date.now())) throw new CompanionImportError('AUTOMATION_TIME_PASSED');
      // This private transaction is reached only after a confirmed source pause.
      // Ordinary saves remain guarded; execution waits for the durable ready bit.
      try { const engine = await getRoutineEngine(); scope.assert(); await engine.put(botId, expected, routineId, routine.revision); }
      catch (error) {
        // A committed enable with a lost acknowledgement must not resume the source as well.
        const saved = await routineTools.list(botId).then(rows => rows.find(item => item.id === routineId), () => { throw new CompanionImportError('TARGET_HANDOVER_UNCERTAIN'); }); scope.assert();
        if (saved?.enabled && JSON.stringify(parseRoutineInput(saved)) !== JSON.stringify(expected)) throw new CompanionImportError('TARGET_HANDOVER_UNCERTAIN');
        if (!saved || JSON.stringify(parseRoutineInput(saved)) !== JSON.stringify(expected)) throw error;
      }
      try {
        await companionEnvironmentStore.update(scope.root, botId, scope.assert, env => {
          const binding = env.automations?.[routineId];
          if (!binding) throw new CompanionImportError('AUTOMATION_NOT_FOUND');
          binding.handover = 'ready';
        });
      } catch {
        // The target was enabled. Keep the source paused if this acknowledgement
        // cannot be persisted; recovery retries it before any work is dispatched.
        throw new CompanionImportError('TARGET_HANDOVER_UNCERTAIN');
      }
    },
  };
  const task = (async () => {
    for (;;) {
      scope.assert();
      const result = await transferCompanion(snapshot, selection, transferDeps);
      if (result.status !== 'running') return result;
      // A native task can still be finishing when it is paused. Reconcile the
      // durable handover on the host even if the mobile link/dialog closes.
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  })().then(async result => {
    if (result.status === 'complete') await companionEnvironmentStore.update(scope.root, result.botId, scope.assert, env => { delete env.pendingImport; });
    return result;
  }).catch(async error => {
    scope.assert();
    const receipt = await readReceipt(scope.root, selection.requestId);
    if (receipt) {
      receipt.result.status = 'needs-attention';
      receipt.result.checks.push({ entryId: 'import', status: 'needs-attention', message: error instanceof CompanionImportError ? error.code : 'IMPORT_FAILED' });
      await saveReceipt(scope.root, receipt);
      return receipt.result;
    }
    throw error;
  }).finally(() => { if (jobs.get(jobKey) === task) jobs.delete(jobKey); });
  jobs.set(jobKey, task);
  return accepted(task, scope.root, selection.requestId);
}

async function accepted(task: Promise<CompanionImportResult>, root: string, requestId: string): Promise<CompanionImportResult> {
  // Accept only after the durable receipt exists. Completion keeps running on the host.
  let finished = false;
  void task.then(() => { finished = true; }, () => { finished = true; });
  const receipt = (async () => {
    while (!finished) {
      const value = await readReceipt(root, requestId);
      if (value) return value.result;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return task;
  })();
  return Promise.race([task, receipt]);
}
