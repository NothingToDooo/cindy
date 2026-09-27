import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { fingerprint } from './files.js';
import { CompanionImportError, type ImportedMcpServer } from './types.js';

/** Never returned over IPC, included in profile JSON, or passed to a language model. */
export interface CompanionEnvironment {
  version: 1;
  env: Record<string, string>;
  mcp: ImportedMcpServer[];
  credentials: Array<{ id: string; format: string; value: unknown }>;
  files?: Record<string, string>;
  sourceAutomations?: Array<{ entryId: string; kind: 'hermes' | 'openclaw'; original: Record<string, unknown> }>;
  /** Selected content only; encrypted restart checkpoint, removed after successful completion. */
  pendingImport?: { selection: import('@cindy/maker-shared/companion-import').CompanionImportSelection; snapshotJson: string };
  /** Only selected automation definitions; may contain source URLs/tokens, so remain encrypted. */
  automations?: Record<string, { kind: 'hermes' | 'openclaw'; original: Record<string, unknown>; sourceRoot: string;
    /** Missing or pending means source ownership has not been safely handed over. */
    handover?: 'pending' | 'ready';
    issues?: string[]; deliveries?: import('./types.js').ImportedDelivery[]; completed?: number; lastRun?: string;
    monitorHash?: string; monitorOutput?: string; prepared?: { runId: string; prompt: string; direct?: string; skipped?: boolean; monitorHash?: string; monitorOutput?: string } }>;
}

export interface CompanionSecretIo {
  read(key: string): string | null;
  write(key: string, value: string): boolean;
  remove(key: string): boolean;
}

function bindingPath(userData: string, botId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(botId)) throw new CompanionImportError('INVALID_COMPANION');
  return path.join(userData, 'bots', botId, 'environment.json');
}
export const companionEnvironmentKey = (botId: string): string => `bot_environment_${fingerprint(botId)}`;

/** A companion owns its binding; secret bytes use the existing account-scoped encrypted store. */
export function createCompanionEnvironmentStore(io: CompanionSecretIo) {
  const queues = new Map<string, Promise<unknown>>();
  const store = {
    async write(userData: string, botId: string, value: CompanionEnvironment, assertOwner: () => void): Promise<void> {
      const file = bindingPath(userData, botId);
      assertOwner();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      assertOwner();
      const encoded = JSON.stringify(value);
      if (!io.write(companionEnvironmentKey(botId), encoded) || io.read(companionEnvironmentKey(botId)) !== encoded)
        throw new CompanionImportError('CREDENTIAL_STORAGE_FAILED');
      assertOwner();
      // No paths, values, endpoint query strings or headers in this manifest.
      const manifest = JSON.stringify({ version: 1, variables: Object.keys(value.env), connections: value.mcp.map(server => server.name), revision: fingerprint(encoded) });
      atomicWriteFileSync(file, manifest);
    },
    async read(userData: string, botId: string, assertOwner: () => void): Promise<CompanionEnvironment | undefined> {
      assertOwner();
      if (readAtomicFileSync(bindingPath(userData, botId)) === null) return undefined;
      assertOwner();
      const encoded = io.read(companionEnvironmentKey(botId));
      if (encoded === null) throw new CompanionImportError('CREDENTIAL_STORAGE_UNAVAILABLE');
      let result: CompanionEnvironment;
      try { result = JSON.parse(encoded) as CompanionEnvironment; }
      catch { throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID'); }
      if (result.version !== 1 || !result.env || !Array.isArray(result.mcp) || !Array.isArray(result.credentials))
        throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
      assertOwner();
      return result;
    },
    remove(botId: string): void {
      if (!io.remove(companionEnvironmentKey(botId))) throw new CompanionImportError('CREDENTIAL_STORAGE_FAILED');
    },
    async update(userData: string, botId: string, assertOwner: () => void, mutate: (environment: CompanionEnvironment) => void): Promise<void> {
      const key = `${userData}:${botId}`;
      const task = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const environment = await store.read(userData, botId, assertOwner);
        if (!environment) throw new CompanionImportError('CREDENTIAL_STORAGE_UNAVAILABLE');
        mutate(environment); await store.write(userData, botId, environment, assertOwner);
      });
      queues.set(key, task);
      try { await task; } finally { if (queues.get(key) === task) queues.delete(key); }
    },
  };
  return store;
}
