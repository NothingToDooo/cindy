import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
  },
}));

const {
  defaultOrcaWorkerCreationPrefs,
  readOrcaWorkerCreationPrefs,
  resetOrcaWorkerCreationPrefsMemory,
  sanitizeOrcaWorkerCreationPrefs,
  saveOrcaWorkerCreationPrefs,
} = await import('@/session/orcaWorkerPrefs');

beforeEach(() => {
  storage.clear();
  resetOrcaWorkerCreationPrefsMemory();
});

describe('Worker creation preferences', () => {
  it('starts from the same first-time defaults as the desktop create panel', () => {
    expect(defaultOrcaWorkerCreationPrefs()).toEqual({
      lastAgent: 'codex',
      agents: {
        codex: { model: 'codex/gpt-5.5', effort: 'high', fast: false },
        'claude-code': { model: 'claude-opus-4-7', effort: 'high', fast: false },
        pi: { model: 'claude-sonnet-4-6', effort: 'high', fast: false },
      },
      workerPermissionMode: 'bypassPermissions',
    });
  });

  it('falls back field by field for damaged memory', () => {
    const prefs = sanitizeOrcaWorkerCreationPrefs({
      lastAgent: 'nope',
      agents: { pi: { model: 'my-model', effort: '', fast: 'yes' } },
      workerPermissionMode: 'auto',
    });
    expect(prefs.lastAgent).toBe('codex');
    expect(prefs.agents.pi).toEqual({ model: 'my-model', effort: 'high', fast: false });
    expect(prefs.agents.codex.model).toBe('codex/gpt-5.5');
    expect(prefs.workerPermissionMode).toBe('auto');
  });

  it('persists per account and reads the saved choice back', async () => {
    const next = { ...defaultOrcaWorkerCreationPrefs(), lastAgent: 'pi' as const, workerPermissionMode: 'auto' as const };
    saveOrcaWorkerCreationPrefs('user-1', next);
    await Promise.resolve();
    resetOrcaWorkerCreationPrefsMemory();
    await expect(readOrcaWorkerCreationPrefs('user-1')).resolves.toEqual(next);
    await expect(readOrcaWorkerCreationPrefs('user-2')).resolves.toEqual(defaultOrcaWorkerCreationPrefs());
  });

  it('keeps a choice saved while an older read was still in flight', async () => {
    storage.set('cindy:orcaWorkerCreationPrefs:v1:user-1', JSON.stringify({
      ...defaultOrcaWorkerCreationPrefs(), workerPermissionMode: 'bypassPermissions',
    }));
    const pending = readOrcaWorkerCreationPrefs('user-1');
    const next = { ...defaultOrcaWorkerCreationPrefs(), lastAgent: 'pi' as const, workerPermissionMode: 'auto' as const };
    saveOrcaWorkerCreationPrefs('user-1', next);
    await expect(pending).resolves.toEqual(next);
    await expect(readOrcaWorkerCreationPrefs('user-1')).resolves.toEqual(next);
  });
});
