// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
  },
}));
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ subscribeRemoteOrcaWorkerChanged: () => () => undefined }));
vi.mock('@/session/ContextSheetCollabView', () => ({ canSubmitOrcaWorkerForm: () => true }));
vi.mock('@/session/fullAccessConfirmation', () => ({ confirmFullAccessChange: async () => true }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { applySessionPatch: vi.fn() } }));

const { useOrcaWorkerForm } = await import('@/session/useSessionOrcaCollab');
const { resetOrcaWorkerCreationPrefsMemory, saveOrcaWorkerCreationPrefs, defaultOrcaWorkerCreationPrefs } =
  await import('@/session/orcaWorkerPrefs');

let root: Root;
let latest: ReturnType<typeof useOrcaWorkerForm> | null = null;

function Probe({ maker }: { maker: MobileMakerTransport }) {
  latest = useOrcaWorkerForm({ maker, prefsScope: 'user-1', active: false, setSheetOpen: () => undefined });
  return null;
}

const model = (id: string, efforts = ['low', 'high']) => ({
  id, label: id, efforts, effortDisplayNames: {}, defaultEffort: efforts[0] ?? null, supportsFastMode: true,
});

function fakeMaker(): MobileMakerTransport {
  return {
    listAvailableAgents: vi.fn(async () => ['claude-code', 'codex', 'pi']),
    getCapabilities: vi.fn(async (agent: string) => ({
      hasFastMode: true,
      availableModels: agent === 'pi' ? [model('pi-model')] : [model('codex/gpt-5.5'), model('claude-opus-4-7')],
    })),
  } as unknown as MobileMakerTransport;
}

const flush = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  storage.clear();
  resetOrcaWorkerCreationPrefsMemory();
  latest = null;
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

it('restores the last Agent and its remembered model, and drops models the computer cannot run', async () => {
  saveOrcaWorkerCreationPrefs('user-1', {
    ...defaultOrcaWorkerCreationPrefs(),
    lastAgent: 'pi',
    workerPermissionMode: 'auto',
    agents: { ...defaultOrcaWorkerCreationPrefs().agents, pi: { model: 'retired', effort: 'high', fast: false } },
  });
  resetOrcaWorkerCreationPrefsMemory();
  await act(async () => root.render(<Probe maker={fakeMaker()} />));
  await act(async () => { latest!.reset(); await flush(); });
  expect(latest!.form.agent).toBe('pi');
  expect(latest!.form.permissionMode).toBe('auto');
  // 记住的模型在这台电脑上已下线 → 回落「默认」,交给电脑端解析。
  expect(latest!.form.model).toBeNull();

  await act(async () => { latest!.changeAgent('codex'); await flush(); });
  expect(latest!.form.model).toEqual({ id: 'codex/gpt-5.5', providerId: null, effort: 'high', fast: false });
});

it('remembers the submitted choice for next time', async () => {
  await act(async () => root.render(<Probe maker={fakeMaker()} />));
  await act(async () => { latest!.reset(); await flush(); });
  await act(async () => {
    latest!.remember({
      ...latest!.form,
      agent: 'claude-code',
      model: { id: 'claude-opus-4-7', providerId: 'anthropic', effort: 'low', fast: true },
      permissionMode: 'auto',
      initialTask: 'not remembered',
    });
  });
  resetOrcaWorkerCreationPrefsMemory();
  await act(async () => { latest!.reset(); await flush(); });
  expect(latest!.form).toEqual({
    role: 'developer',
    agent: 'claude-code',
    model: { id: 'claude-opus-4-7', providerId: null, effort: 'low', fast: true },
    permissionMode: 'auto',
    initialTask: '',
  });
});

it('never lets a late memory read overwrite a permission the user already chose', async () => {
  saveOrcaWorkerCreationPrefs('user-1', { ...defaultOrcaWorkerCreationPrefs(), workerPermissionMode: 'bypassPermissions' });
  resetOrcaWorkerCreationPrefsMemory();
  // 预读还没完成就打开表单并立刻改成「自动审批」。
  await act(async () => root.render(<Probe maker={fakeMaker()} />));
  act(() => { latest!.reset(); });
  await act(async () => { await latest!.changePermission('auto'); });
  await act(async () => { await flush(); });
  expect(latest!.form.permissionMode).toBe('auto');
});

it('keeps every Worker action menu within three buttons for Android', async () => {
  const { Alert } = await import('react-native');
  const { useSessionOrcaCollab } = await import('@/session/useSessionOrcaCollab');
  let collab: ReturnType<typeof useSessionOrcaCollab> | null = null;
  const maker = {
    ...fakeMaker(),
    orca: {
      listWorkers: vi.fn(async () => []),
      getCollaborationSettings: vi.fn(async () => ({})),
      getTeamByWorkerSession: vi.fn(async () => null),
    },
  } as unknown as MobileMakerTransport;
  function Host() {
    collab = useSessionOrcaCollab({
      maker, deviceId: 'dev-1', sessionId: 'lead-1', prefsScope: 'user-1', enabled: true,
      session: { id: 'lead-1', orcaRole: 'lead', workspaceKind: 'project', workingDir: '/repo', agentKind: 'codex' } as never,
      sheetView: null, sheetOpen: false, setSheetView: () => undefined, setSheetOpen: () => undefined, openSession: () => undefined,
    });
    return null;
  }
  await act(async () => root.render(<Host />));
  const alert = vi.mocked(Alert.alert);
  const worker = { workerId: 'w-1', sessionId: 's-1', role: 'developer', label: null, status: 'idle' as const, focused: false, agentKind: 'codex' as const, model: null, effort: null, title: null };
  act(() => collab!.pressWorker(worker));
  const first = alert.mock.calls.at(-1)![2]!;
  expect(first.length).toBeLessThanOrEqual(3);
  act(() => first.find((button) => button.text === 'More actions' || button.text === '更多操作')?.onPress?.());
  expect(alert.mock.calls.at(-1)![2]!.length).toBeLessThanOrEqual(3);
  act(() => collab!.pressWorker({ ...worker, focused: true }));
  expect(alert.mock.calls.at(-1)![2]!.length).toBeLessThanOrEqual(3);
});
