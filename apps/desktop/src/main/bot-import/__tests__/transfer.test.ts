import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { transferCompanion, type ImportReceipt, type TransferDeps } from '../transfer.js';
import { CompanionImportError, type ImportSnapshot } from '../types.js';
import type { CompanionImportSelection } from '@cindy/maker-shared/companion-import';

const snapshot: ImportSnapshot = { source: { kind: 'hermes', agentId: 'default', name: 'Ada', root: '/fixture/hermes', workspace: '/fixture/work', configFile: '/fixture/hermes/config.yaml' }, fingerprint: 'fixture', items: [
  { view: { id: 'memory', category: 'memory', name: 'memory', selected: true }, text: 'Keep this' },
  { view: { id: 'unselected', category: 'memory', name: 'private', selected: true }, text: 'Do not copy this' },
  { view: { id: 'env', category: 'connections', name: 'DATA_TOKEN', selected: true }, env: { DATA_TOKEN: 'fake-token-for-testing' } },
  { view: { id: 'task', category: 'automations', name: 'Report', selected: true, enabled: true, dependsOn: ['env'] }, automation: { sourceId: 'source-task', fingerprint: 'fixture', original: {}, input: { name: 'Report', prompt: 'Read my data', enabled: false, triggers: [{ id: 'daily', kind: 'interval', intervalMs: 60000 }] } } },
] };
const selection: CompanionImportSelection = { requestId: 'fixture-request-0001', previewId: 'preview', name: 'Ada', entryIds: ['memory', 'env', 'task'], takeover: true };
function harness() {
  let receipt: ImportReceipt | undefined;
  const deps: TransferDeps = { assertOwner: vi.fn(), readReceipt: async () => structuredClone(receipt), saveReceipt: async value => { receipt = structuredClone(value); },
    createCompanion: vi.fn(async () => {}), importItem: vi.fn(async () => {}), saveEnvironment: vi.fn(async () => {}), saveCheckpoint: vi.fn(async () => {}),
    createConversation: vi.fn(async () => 'chat'), createRoutine: vi.fn(async () => 'routine'),
    verifyAutomation: vi.fn(async () => ({ verified: true })), pauseSource: vi.fn(async () => {}), resumeSource: vi.fn(async () => {}), enableRoutine: vi.fn(async () => {}),
  };
  return { deps, receipt: () => receipt };
}
describe('companion takeover transaction', () => {
  it('copies exactly the selection and verifies before pausing source, idempotently', async () => {
    const { deps } = harness(); const order: string[] = [];
    vi.mocked(deps.verifyAutomation).mockImplementation(async () => { order.push('verify'); return { verified: true }; });
    vi.mocked(deps.pauseSource).mockImplementation(async () => { order.push('pause'); });
    vi.mocked(deps.enableRoutine).mockImplementation(async () => { order.push('enable'); });
    const result = await transferCompanion(snapshot, selection, deps);
    expect(result.status).toBe('complete'); expect(order).toEqual(['verify', 'pause', 'enable']);
    expect(deps.importItem).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(deps.saveEnvironment).mock.calls[0]![1];
    expect(saved.map(item => item.view.id)).toEqual(['memory', 'env', 'task']);
    await expect(transferCompanion(snapshot, selection, deps)).resolves.toEqual(result);
    expect(deps.createRoutine).toHaveBeenCalledTimes(1); expect(deps.pauseSource).toHaveBeenCalledTimes(1);
  });
  it('retains source execution when a needed credential is deselected or read verification fails', async () => {
    const a = harness();
    const result = await transferCompanion(snapshot, { ...selection, entryIds: ['task'] }, a.deps);
    expect(result.status).toBe('needs-attention'); expect(a.deps.verifyAutomation).not.toHaveBeenCalled(); expect(a.deps.pauseSource).not.toHaveBeenCalled();
    const b = harness(); vi.mocked(b.deps.verifyAutomation).mockResolvedValue({ verified: false });
    await transferCompanion(snapshot, selection, b.deps);
    expect(b.deps.pauseSource).not.toHaveBeenCalled(); expect(b.deps.enableRoutine).not.toHaveBeenCalled();
  });
  it('restores the source if enabling the imported task fails and retries without duplicate creation', async () => {
    const { deps, receipt } = harness(); vi.mocked(deps.enableRoutine).mockRejectedValueOnce(new Error('fixture failure'));
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('needs-attention');
    expect(deps.resumeSource).toHaveBeenCalledTimes(1); expect(receipt()?.routines.task?.phase).toBe('verified');
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('complete');
    expect(deps.createRoutine).toHaveBeenCalledTimes(1);
  });
  it('imports disabled tasks without activating or pausing any source task', async () => {
    const source = structuredClone(snapshot); source.items[3]!.view.enabled = false;
    const { deps } = harness();
    const result = await transferCompanion(source, selection, deps);
    expect(result.checks.find(check => check.entryId === 'task')?.status).toBe('paused');
    expect(deps.verifyAutomation).not.toHaveBeenCalled(); expect(deps.enableRoutine).not.toHaveBeenCalled(); expect(deps.pauseSource).not.toHaveBeenCalled();
  });
  it('rejects reusing a request with a different selection', async () => {
    const { deps } = harness(); await transferCompanion(snapshot, selection, deps);
    await expect(transferCompanion(snapshot, { ...selection, entryIds: ['task'] }, deps)).rejects.toThrow('REQUEST_ALREADY_USED');
  });
  it('keeps the source paused when target acknowledgement is ambiguous, and reconciles on retry', async () => {
    const { deps, receipt } = harness();
    vi.mocked(deps.enableRoutine).mockRejectedValueOnce(new CompanionImportError('TARGET_HANDOVER_UNCERTAIN'));
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('running');
    expect(receipt()?.routines.task?.phase).toBe('source-paused');
    expect(deps.resumeSource).not.toHaveBeenCalled();
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('complete');
    expect(deps.pauseSource).toHaveBeenCalledTimes(1);
    expect(deps.saveEnvironment).toHaveBeenCalledTimes(1);
    expect(deps.saveCheckpoint).toHaveBeenCalledTimes(1);
  });
  it('reconciles a lost source pause acknowledgement instead of activating two schedulers', async () => {
    const { deps } = harness();
    vi.mocked(deps.pauseSource).mockRejectedValueOnce(new CompanionImportError('SOURCE_HANDOVER_UNCERTAIN'));
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('running');
    expect(deps.enableRoutine).not.toHaveBeenCalled();
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('complete');
    expect(vi.mocked(deps.pauseSource).mock.calls[1]?.[2]).toBe(true);
  });

});

it('checkpoints full selected skills before acknowledging or copying and resumes after source removal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-checkpoint-test-'));
  try {
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.writeFile(path.join(root, 'SKILL.md'), 'Use scripts/query.py');
    await fs.writeFile(path.join(root, 'scripts/query.py'), 'print("rows")');
    const source: ImportSnapshot = { ...snapshot, items: [...snapshot.items,
      { view: { id: 'skill', name: 'report', category: 'skills', selected: true }, sourceDirectory: root },
    ] };
    const input = { ...selection, entryIds: [...selection.entryIds, 'skill'] };
    const { deps, receipt } = harness();
    let durable: ImportSnapshot | undefined;
    vi.mocked(deps.saveCheckpoint).mockImplementation(async (_botId, items) => {
      // Real JSON serialization mirrors the encrypted store across a process restart.
      durable = JSON.parse(JSON.stringify({ ...source, items }), (_key, value) => value?.type === 'Buffer' ? Buffer.from(value.data) : value);
    });
    vi.mocked(deps.importItem).mockImplementation(async () => {
      expect(durable?.items.some(item => item.view.id === 'unselected')).toBe(false);
      expect(durable?.items.find(item => item.view.id === 'skill')?.files?.map(file => file.name)).toEqual(['scripts/query.py', 'SKILL.md']);
    });
    vi.mocked(deps.importItem).mockRejectedValueOnce(new Error('process interrupted'));
    await expect(transferCompanion(source, input, deps)).rejects.toThrow('process interrupted');
    expect(receipt()?.result.status).toBe('running');
    expect(durable).toBeDefined();
    await fs.rm(root, { recursive: true, force: true });
    vi.mocked(deps.verifyAutomation).mockImplementation(async () => {
      expect(durable?.items.find(item => item.view.id === 'skill')?.files?.find(file => file.name === 'scripts/query.py')?.bytes.toString()).toBe('print("rows")');
      return { verified: true };
    });
    expect((await transferCompanion(durable!, input, deps)).status).toBe('complete');
    expect(deps.pauseSource).toHaveBeenCalledOnce();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
