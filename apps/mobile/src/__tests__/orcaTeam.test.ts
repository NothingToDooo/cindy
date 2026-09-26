import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import {
  buildOrcaEnableOptions,
  convergeOrcaWorkerModel,
  createOrcaWorker,
  describeOrcaError,
  enableOrcaTeam,
  isOrcaCollabEligible,
  orcaWorkerFormFromPrefs,
  readOrcaCollabEntryStatus,
  rememberOrcaStartFailure,
  subscribeOrcaStartFailure,
  takeOrcaStartFailure,
} from '@/session/orcaTeam';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { defaultOrcaWorkerCreationPrefs } from '@/session/orcaWorkerPrefs';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

type OrcaFake = Partial<MobileMakerTransport['orca']>;

function fakeMaker(opts: {
  capabilities?: unknown;
  capabilitiesError?: Error;
  orca?: OrcaFake;
}): MobileMakerTransport {
  return {
    getCapabilities: vi.fn(async () => {
      if (opts.capabilitiesError) throw opts.capabilitiesError;
      return opts.capabilities ?? { supportsOrcaWorkerPermissionMode: true };
    }),
    orca: {
      getCollabPolicy: vi.fn(async () => ({ effectiveEnabled: true })),
      enable: vi.fn(async () => ({ workerSessionId: 'worker-1' })),
      disable: vi.fn(async () => ({ ok: true })),
      createWorker: vi.fn(async () => ({ ok: true, workerSessionId: 'worker-2' })),
      listWorkers: vi.fn(async () => []),
      getTeamByWorkerSession: vi.fn(async () => null),
      switchFocus: vi.fn(async () => ({ ok: true })),
      acknowledgeDone: vi.fn(async () => ({ ok: true })),
      archiveWorker: vi.fn(async () => ({ ok: true })),
      getCollaborationSettings: vi.fn(async () => ({})),
      ...opts.orca,
    },
  } as unknown as MobileMakerTransport;
}

const project = { orcaRole: null, workspaceKind: 'project' as const, workingDir: '/repo', remoteHostId: null };

describe('mobile Orca collaboration entry', () => {
  it('only offers collaboration to Lead-capable tasks', () => {
    expect(isOrcaCollabEligible(project)).toBe(true);
    expect(isOrcaCollabEligible({ ...project, workingDir: '' })).toBe(false);
    expect(isOrcaCollabEligible({ ...project, workspaceKind: 'dialogue', workingDir: null })).toBe(true);
    expect(isOrcaCollabEligible({ ...project, orcaRole: 'worker' })).toBe(false);
    expect(isOrcaCollabEligible(null)).toBe(false);
  });

  it('fails closed when the computer does not declare Worker permission support', async () => {
    const maker = fakeMaker({ capabilities: {} });
    await expect(readOrcaCollabEntryStatus(maker, project, 'codex')).resolves.toBe('unsupported');
    expect(maker.orca.getCollabPolicy).not.toHaveBeenCalled();
  });

  it('maps policy query results to entry states', async () => {
    await expect(readOrcaCollabEntryStatus(fakeMaker({}), project, 'codex')).resolves.toBe('ready');
    await expect(readOrcaCollabEntryStatus(fakeMaker({
      orca: { getCollabPolicy: vi.fn(async () => ({ effectiveEnabled: false })) },
    }), project, 'codex')).resolves.toBe('disabled');
    await expect(readOrcaCollabEntryStatus(fakeMaker({
      orca: { getCollabPolicy: vi.fn(async () => { throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] no'); }) },
    }), project, 'codex')).resolves.toBe('unsupported');
    await expect(readOrcaCollabEntryStatus(fakeMaker({
      orca: { getCollabPolicy: vi.fn(async () => { throw new Error('[NOT_CONNECTED] offline'); }) },
    }), project, 'codex')).resolves.toBe('unavailable');
  });

  it('skips the project policy query for SSH-remote sessions and existing Leads', async () => {
    const remote = fakeMaker({});
    await readOrcaCollabEntryStatus(remote, { ...project, remoteHostId: 'host-1' }, 'claude-code');
    expect(remote.orca.getCollabPolicy).toHaveBeenCalledWith(undefined, 'project');

    const lead = fakeMaker({});
    await expect(readOrcaCollabEntryStatus(lead, { ...project, orcaRole: 'lead' }, 'claude-code')).resolves.toBe('ready');
    expect(lead.orca.getCollabPolicy).not.toHaveBeenCalled();
  });
});

describe('mobile Orca collaboration mutations', () => {
  const form = {
    ...orcaWorkerFormFromPrefs({ ...defaultOrcaWorkerCreationPrefs(), workerPermissionMode: 'auto' }, 'codex'),
    model: null,
    role: 'Reviewer',
    initialTask: 'check tests',
  };

  it('builds enable options with a derived label and only the chosen model fields', () => {
    expect(buildOrcaEnableOptions(form, 'task')).toEqual({
      workerAgent: 'codex',
      role: 'Reviewer',
      label: 'reviewer',
      workerPermissionMode: 'auto',
      delegateTask: 'task',
    });
    expect(buildOrcaEnableOptions({
      ...form,
      model: { id: 'gpt-5.5', providerId: 'openai', effort: 'high', fast: true },
    }, '  ')).toEqual({
      workerAgent: 'codex',
      role: 'Reviewer',
      label: 'reviewer',
      model: 'gpt-5.5',
      effort: 'high',
      fast: true,
      providerId: 'openai',
      workerPermissionMode: 'auto',
    });
  });

  it('restores the remembered Worker choice like the desktop create panel', () => {
    const prefs = defaultOrcaWorkerCreationPrefs();
    expect(orcaWorkerFormFromPrefs(prefs, prefs.lastAgent)).toEqual({
      role: 'developer',
      agent: 'codex',
      model: { id: 'codex/gpt-5.5', providerId: null, effort: 'high', fast: false },
      permissionMode: 'bypassPermissions',
      initialTask: '',
    });
  });

  it('converges a remembered model to what the computer can run', () => {
    const capabilities = {
      hasFastMode: true,
      availableModels: [{
        id: 'gpt-5.5', label: 'GPT', efforts: ['low', 'medium'], effortDisplayNames: {},
        defaultEffort: 'medium', supportsFastMode: false,
      }],
    };
    expect(convergeOrcaWorkerModel({ id: 'gone', providerId: null, effort: 'high', fast: false }, capabilities)).toBeNull();
    expect(convergeOrcaWorkerModel({ id: 'gpt-5.5', providerId: null, effort: 'high', fast: true }, capabilities))
      .toEqual({ id: 'gpt-5.5', providerId: null, effort: 'medium', fast: false });
    const kept = { id: 'x', providerId: null, effort: 'high', fast: true };
    expect(convergeOrcaWorkerModel(kept, null)).toBe(kept);
    expect(convergeOrcaWorkerModel(null, capabilities)).toBeNull();
  });

  it('re-checks capabilities before enabling and refuses on downgraded hosts', async () => {
    const maker = fakeMaker({ capabilities: { supportsOrcaWorkerPermissionMode: false } });
    await expect(enableOrcaTeam(maker, 'lead-1', buildOrcaEnableOptions(form))).rejects.toThrow('CHANNEL_NOT_ALLOWED');
    expect(maker.orca.enable).not.toHaveBeenCalled();
  });

  it('treats a tunnel timeout as ambiguous and confirms the team from the Worker list', async () => {
    const maker = fakeMaker({
      orca: {
        enable: vi.fn(async () => { throw new Error('[INVOKE_TIMEOUT] timed out'); }),
        listWorkers: vi.fn(async () => [{ id: 'w-1', sessionId: 'worker-9' }]),
      },
    });
    await expect(enableOrcaTeam(maker, 'lead-1', buildOrcaEnableOptions(form))).resolves.toEqual({ workerSessionId: 'worker-9' });
    expect(maker.orca.enable).toHaveBeenCalledTimes(1);
  });

  it('confirms an already-existing team from the Worker list before treating it as started', async () => {
    const withWorker = fakeMaker({
      orca: {
        enable: vi.fn(async () => { throw new Error('[ALREADY_EXISTS] active team'); }),
        listWorkers: vi.fn(async () => [{ id: 'w-1', sessionId: 'worker-7' }]),
      },
    });
    await expect(enableOrcaTeam(withWorker, 'lead-1', buildOrcaEnableOptions(form))).resolves.toEqual({ workerSessionId: 'worker-7' });

    // 团队已建但首个 Worker 没落库:不能按成功处理。
    const teamOnly = fakeMaker({
      orca: {
        enable: vi.fn(async () => { throw new Error('[ALREADY_EXISTS] active team'); }),
        listWorkers: vi.fn(async () => []),
      },
    });
    vi.useFakeTimers();
    const pending = enableOrcaTeam(teamOnly, 'lead-1', buildOrcaEnableOptions(form));
    const assertion = expect(pending).rejects.toThrow('ALREADY_EXISTS');
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });

  it('does not retry authoritative enable failures', async () => {
    const maker = fakeMaker({
      orca: { enable: vi.fn(async () => { throw new Error('[PRECONDITION_FAILED] disabled'); }) },
    });
    await expect(enableOrcaTeam(maker, 'lead-1', buildOrcaEnableOptions(form))).rejects.toThrow('PRECONDITION_FAILED');
    expect(maker.orca.listWorkers).not.toHaveBeenCalled();
  });

  it('re-derives the label from a fresh Worker list after a duplicate-label race', async () => {
    const createWorker = vi.fn()
      .mockRejectedValueOnce(new Error('[DUPLICATE_LABEL] taken'))
      .mockResolvedValueOnce({ ok: true, workerSessionId: 'worker-3' });
    const maker = fakeMaker({
      orca: {
        createWorker,
        listWorkers: vi.fn(async () => [{ id: 'w-1', sessionId: 's-1', role: 'reviewer', label: 'reviewer' }]),
      },
    });
    await expect(createOrcaWorker(maker, 'lead-1', form, [])).resolves.toEqual({ workerSessionId: 'worker-3' });
    expect(createWorker.mock.calls.map((call) => call[0].label)).toEqual(['reviewer', 'reviewer-2']);
    expect(createWorker.mock.calls[1][0]).toMatchObject({ initialTask: 'check tests', agent: 'codex' });
  });

  it('refuses to create Workers on computers that would ignore the chosen permission', async () => {
    const maker = fakeMaker({ capabilities: {} });
    await expect(createOrcaWorker(maker, 'lead-1', form, [])).rejects.toThrow('CHANNEL_NOT_ALLOWED');
    expect(maker.orca.createWorker).not.toHaveBeenCalled();
  });

  it('confirms a timed-out Worker creation by its exact label instead of retrying', async () => {
    const createWorker = vi.fn(async () => { throw new Error('[INVOKE_TIMEOUT] timed out'); });
    const landed = fakeMaker({
      orca: {
        createWorker,
        listWorkers: vi.fn(async () => [
          { id: 'w-0', sessionId: 'old', role: 'reviewer', label: 'other' },
          { id: 'w-1', sessionId: 'new', role: 'Reviewer', label: 'reviewer' },
        ]),
      },
    });
    await expect(createOrcaWorker(landed, 'lead-1', form, [])).resolves.toEqual({ workerSessionId: 'new' });
    expect(createWorker).toHaveBeenCalledTimes(1);

    const lost = fakeMaker({
      orca: {
        createWorker: vi.fn(async () => { throw new Error('[INVOKE_TIMEOUT] timed out'); }),
        listWorkers: vi.fn(async () => []),
      },
    });
    vi.useFakeTimers();
    const pending = createOrcaWorker(lost, 'lead-1', form, []);
    const assertion = expect(pending).rejects.toThrow('ORCA_CREATE_UNCONFIRMED');
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
    expect(lost.orca.createWorker).toHaveBeenCalledTimes(1);
    expect(describeOrcaError(new Error('[ORCA_CREATE_UNCONFIRMED] x'), 'session.collab.errors.createFailed'))
      .toContain('暂时无法确认是否成功');
  });

  it('describes known Orca errors in the interface language', () => {
    expect(describeOrcaError(new Error('[WORKER_LIMIT_HARD_EXCEEDED] full'), 'session.collab.errors.createFailed'))
      .toBe('已达 Worker 硬上限，请先归档现有 Worker。');
    expect(describeOrcaError(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] old'), 'session.collab.errors.startFailed'))
      .toBe('电脑端版本过旧，暂不支持协同');
    expect(describeOrcaError(new Error('boom'), 'session.collab.errors.startFailed')).toContain('开启协同失败。');
  });

  it('hands a new-task start failure to the session page exactly once, including late failures', () => {
    rememberOrcaStartFailure('s-1', 'reason');
    expect(takeOrcaStartFailure('s-1')).toBe('reason');
    expect(takeOrcaStartFailure('s-1')).toBeNull();

    const seen: string[] = [];
    const unsubscribe = subscribeOrcaStartFailure((sessionId) => seen.push(sessionId));
    rememberOrcaStartFailure('s-2', 'late');
    unsubscribe();
    rememberOrcaStartFailure('s-3', 'after');
    expect(seen).toEqual(['s-2']);
  });

  it('bounds the timeout probe by an overall deadline', async () => {
    vi.useFakeTimers();
    const listWorkers = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 20_000)));
    const maker = fakeMaker({
      orca: { enable: vi.fn(async () => { throw new Error('[INVOKE_TIMEOUT] timed out'); }), listWorkers },
    });
    const pending = enableOrcaTeam(maker, 'lead-1', buildOrcaEnableOptions(form));
    const assertion = expect(pending).rejects.toThrow('INVOKE_TIMEOUT');
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
    // 20s 一次的探针在 30s 总时限内只来得及两次,不会跑满四次。
    expect(listWorkers.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
