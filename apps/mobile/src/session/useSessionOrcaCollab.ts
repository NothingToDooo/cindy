/**
 * 手机端协同(Orca)页面状态。
 *
 *  - useOrcaWorkerForm:「开启协同 / 创建新 Worker」表单状态(会话页与新建任务页共用),含
 *    完全访问确认与 Worker 模型选择器的开合编排。
 *  - useSessionOrcaCollab:会话页 + 面板「协同模式」二级视图、团队操作与 Lead / Worker 导航。
 *
 * 真身在被控端;所有写操作完成后以被控端列表为准(整表重拉),本地只在开启 / 结束协同时
 * 乐观改 orcaRole,权威值随 sessions 推送回流。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import type { AgentKind } from '@cindy/model-providers/types';
import { confirmFullAccessChange } from '@/session/fullAccessConfirmation';
import {
  buildOrcaEnableOptions,
  createOrcaWorker,
  defaultOrcaWorkerForm,
  describeOrcaError,
  enableOrcaTeam,
  isOrcaCollabEligible,
  orcaAgentKindForSession,
  orcaCollabEntryHint,
  orcaWorkerDisplayName,
  orcaWorkerStatusLabel,
  readOrcaCollabEntryStatus,
  type OrcaCollabEntryStatus,
  type OrcaTeamWorker,
  type OrcaWorkerAgentKind,
  type OrcaWorkerFormValue,
  type OrcaWorkerPermissionMode,
} from '@/session/orcaTeam';
import {
  DEFAULT_ORCA_COLLABORATION_SETTINGS,
  parseOrcaCollaborationSettings,
  parseOrcaPermissionMode,
  parseOrcaTeamWorkers,
  readOrcaTeamLeadSessionId,
  type OrcaCollaborationSettings,
} from '@cindy/maker-shared/orca-team';
import { subscribeRemoteOrcaWorkerChanged } from '@/device-link/DeviceLinkContext';
import { canSubmitOrcaWorkerForm } from '@/session/ContextSheetCollabView';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { i18n } from '@/i18n';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import type { MobileModelConfiguration } from '@/session/unifiedMobileModels';
import type { RemoteSession } from '@/session/types';

export type CollabSheetView = 'collab' | 'collab-create';

const ALL_AGENTS: readonly OrcaWorkerAgentKind[] = ['claude-code', 'codex', 'pi'];

// ─── 团队状态 ────────────────────────────────────────────────────────────────

export interface OrcaTeamSnapshot {
  workers: OrcaTeamWorker[];
  settings: OrcaCollaborationSettings;
  loading: boolean;
  error: string | null;
}

const EMPTY_TEAM: OrcaTeamSnapshot = {
  workers: [],
  settings: DEFAULT_ORCA_COLLABORATION_SETTINGS,
  loading: false,
  error: null,
};

/**
 * Lead 任务的 Worker 列表 + 协同设置。`leadSessionId` 为 null 时不拉取。被控端推送
 * worker-changed(需会话页持有 `session:<leadId>` topic)或调用 refresh 时整表重拉;
 * 旧请求的迟到结果按请求代次丢弃。
 */
export function useOrcaTeam(params: {
  maker: MobileMakerTransport;
  deviceId: string | null;
  leadSessionId: string | null;
}): OrcaTeamSnapshot & { refresh(): Promise<void> } {
  const { maker, deviceId, leadSessionId } = params;
  const [snapshot, setSnapshot] = useState<OrcaTeamSnapshot>(EMPTY_TEAM);
  const generationRef = useRef(0);
  const makerRef = useRef(maker);
  makerRef.current = maker;

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!leadSessionId) {
      setSnapshot(EMPTY_TEAM);
      return;
    }
    setSnapshot((current) => ({ ...current, loading: true }));
    try {
      const [workers, settings] = await Promise.all([
        makerRef.current.orca.listWorkers(leadSessionId),
        makerRef.current.orca.getCollaborationSettings().catch(() => null),
      ]);
      if (generation !== generationRef.current) return;
      setSnapshot({
        workers: parseOrcaTeamWorkers(workers),
        settings: parseOrcaCollaborationSettings(settings),
        loading: false,
        error: null,
      });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setSnapshot((current) => ({
        ...current,
        loading: false,
        error: describeOrcaError(error, 'session.collab.errors.loadFailed'),
      }));
    }
  }, [leadSessionId]);

  useEffect(() => {
    setSnapshot(EMPTY_TEAM);
    void refresh();
    return () => { generationRef.current += 1; };
  }, [deviceId, refresh]);

  useEffect(() => {
    if (!deviceId || !leadSessionId) return undefined;
    return subscribeRemoteOrcaWorkerChanged((pushDeviceId, pushLeadSessionId) => {
      if (pushDeviceId === deviceId && pushLeadSessionId === leadSessionId) void refresh();
    });
  }, [deviceId, leadSessionId, refresh]);

  return { ...snapshot, refresh };
}

/** Worker 任务 → 所属 Lead(被控端团队记录为准;查不到 = null,「返回 Lead」入口不出现)。 */
export function useOrcaWorkerLeadSessionId(params: {
  maker: MobileMakerTransport;
  workerSessionId: string | null;
}): string | null {
  const { maker, workerSessionId } = params;
  const [leadSessionId, setLeadSessionId] = useState<string | null>(null);
  const makerRef = useRef(maker);
  makerRef.current = maker;
  useEffect(() => {
    setLeadSessionId(null);
    if (!workerSessionId) return undefined;
    let cancelled = false;
    makerRef.current.orca.getTeamByWorkerSession(workerSessionId)
      .then((team) => { if (!cancelled) setLeadSessionId(readOrcaTeamLeadSessionId(team)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [workerSessionId]);
  return leadSessionId;
}


/**
 * Worker 表单状态。`active` 为真(面板展示协同视图)时读一次被控端可用 Agent;
 * 模型选择器与 + 面板是两个 sheet(iOS 原生 sheet 不能叠开):选模型前收起面板,
 * 选择器完全收起后再展开面板回到表单。
 */
export function useOrcaWorkerForm(params: {
  maker: MobileMakerTransport;
  active: boolean;
  defaultAgent: OrcaWorkerAgentKind;
  setSheetOpen(open: boolean): void;
}) {
  const { maker, active, defaultAgent, setSheetOpen } = params;
  const [form, setForm] = useState<OrcaWorkerFormValue>(() => defaultOrcaWorkerForm(defaultAgent, null));
  const [customRoleMode, setCustomRoleMode] = useState(false);
  const [agents, setAgents] = useState<readonly OrcaWorkerAgentKind[]>(ALL_AGENTS);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const makerRef = useRef(maker);
  makerRef.current = maker;

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    makerRef.current.listAvailableAgents()
      .then((available) => {
        if (cancelled) return;
        const next = ALL_AGENTS.filter((agent) => available.includes(agent));
        if (next.length > 0) setAgents(next);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, maker]);

  /** 复位为默认值;权限先用已知偏好,再异步读被控端记住的 Worker 权限偏好覆盖。 */
  const reset = useCallback((agent: OrcaWorkerAgentKind, knownPermission: OrcaWorkerPermissionMode | null) => {
    setForm(defaultOrcaWorkerForm(agent, knownPermission));
    setCustomRoleMode(false);
    makerRef.current.orca.getCollaborationSettings()
      .then((raw) => {
        const mode = parseOrcaPermissionMode((raw as { workerPermissionMode?: unknown } | null)?.workerPermissionMode);
        if (mode) setForm((current) => ({ ...current, permissionMode: mode }));
      })
      .catch(() => undefined);
  }, []);

  const patch = useCallback((next: Partial<OrcaWorkerFormValue>) => {
    setForm((current) => ({ ...current, ...next }));
  }, []);

  const changePermission = useCallback(async (mode: OrcaWorkerPermissionMode) => {
    if (!await confirmFullAccessChange(form.permissionMode, mode)) return;
    setForm((current) => ({ ...current, permissionMode: mode }));
  }, [form.permissionMode]);

  const openPicker = useCallback(() => {
    setSheetOpen(false);
    setModelPickerOpen(true);
  }, [setSheetOpen]);
  const close = useCallback(() => setModelPickerOpen(false), []);
  const closed = useCallback(() => setSheetOpen(true), [setSheetOpen]);
  const select = useCallback(async (config: MobileModelConfiguration): Promise<boolean> => {
    if (!ALL_AGENTS.includes(config.agent as OrcaWorkerAgentKind)) return false;
    setForm((current) => ({
      ...current,
      agent: config.agent as OrcaWorkerAgentKind,
      model: {
        id: config.modelId,
        providerId: config.providerId || null,
        effort: config.effort || null,
        fast: !!config.fast,
      },
    }));
    return true;
  }, []);

  const pickerAgents = useMemo<AgentKind[]>(() => [...agents], [agents]);

  return {
    form,
    setForm,
    customRoleMode,
    setCustomRoleMode,
    patch,
    changePermission,
    agents,
    pickerAgents,
    valid: canSubmitOrcaWorkerForm(form, customRoleMode),
    reset,
    modelPicker: { open: modelPickerOpen, openPicker, close, closed, select },
  };
}

export function useSessionOrcaCollab(params: {
  maker: MobileMakerTransport;
  deviceId: string | null;
  sessionId: string;
  session: RemoteSession | null;
  /** 共享任务访客 / 宿主托管任务不提供协同编排(不拉团队、不挂入口)。 */
  enabled: boolean;
  /** + 面板当前是否展示协同视图。 */
  sheetView: CollabSheetView | null;
  sheetOpen: boolean;
  setSheetView(view: 'main' | CollabSheetView): void;
  setSheetOpen(open: boolean): void;
  openSession(sessionId: string): void;
}) {
  const { maker, deviceId, sessionId, session, enabled, sheetView, sheetOpen, setSheetView, setSheetOpen, openSession } = params;
  const role = enabled ? session?.orcaRole ?? null : null;
  const isLead = role === 'lead';
  const isWorker = role === 'worker';
  const eligible = enabled && (isLead || isOrcaCollabEligible(session));
  const sessionAgent = session ? orcaAgentKindForSession(session) : 'claude-code';
  const team = useOrcaTeam({ maker, deviceId, leadSessionId: isLead ? sessionId : null });
  const workerLeadSessionId = useOrcaWorkerLeadSessionId({ maker, workerSessionId: isWorker ? sessionId : null });
  const workerForm = useOrcaWorkerForm({
    maker,
    active: sheetOpen && sheetView !== null,
    defaultAgent: sessionAgent,
    setSheetOpen,
  });

  const [entryStatus, setEntryStatus] = useState<OrcaCollabEntryStatus>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const makerRef = useRef(maker);
  makerRef.current = maker;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // 换任务:错误与入口状态都属于上一个任务,整体复位。
  useEffect(() => {
    setEntryStatus('loading');
    setError(null);
    setBusy(false);
  }, [sessionId, deviceId]);

  // 打开 + 面板时读一次入口状态(能力 + 协同插件开关);Lead 只需确认能力。
  useEffect(() => {
    const current = sessionRef.current;
    if (!sheetOpen || !eligible || !current) return undefined;
    let cancelled = false;
    setEntryStatus('loading');
    void readOrcaCollabEntryStatus(makerRef.current, current, orcaAgentKindForSession(current))
      .then((status) => { if (!cancelled) setEntryStatus(status); });
    return () => { cancelled = true; };
  }, [sheetOpen, eligible, sessionId, role]);

  // 协同视图展示中时顺带刷新一次团队(推送之外的兜底)。
  const refreshTeam = team.refresh;
  useEffect(() => {
    if (sheetOpen && sheetView === 'collab' && isLead) void refreshTeam();
  }, [sheetOpen, sheetView, isLead, refreshTeam]);

  const resetWorkerForm = workerForm.reset;
  /** + 面板主视图的「协同模式」行:Lead 进团队面板,其它进开启表单。 */
  const openFromMain = useCallback(() => {
    setError(null);
    if (!isLead) resetWorkerForm(sessionAgent, team.settings.workerPermissionMode);
    setSheetView('collab');
  }, [isLead, resetWorkerForm, sessionAgent, setSheetView, team.settings.workerPermissionMode]);

  const openCreateWorker = useCallback(() => {
    setError(null);
    resetWorkerForm(sessionAgent, team.settings.workerPermissionMode);
    setSheetView('collab-create');
  }, [resetWorkerForm, sessionAgent, setSheetView, team.settings.workerPermissionMode]);

  const form = workerForm.form;
  const formValid = workerForm.valid;

  const submitEnable = useCallback(async () => {
    if (!deviceId || !formValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await enableOrcaTeam(makerRef.current, sessionId, buildOrcaEnableOptions(form, form.initialTask));
      remoteSessionStore.applySessionPatch(deviceId, sessionId, { orcaRole: 'lead' });
      setSheetView('collab');
      void refreshTeam();
    } catch (err) {
      setError(describeOrcaError(err, 'session.collab.errors.startFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, deviceId, form, formValid, refreshTeam, sessionId, setSheetView]);

  const submitCreate = useCallback(async () => {
    if (!formValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createOrcaWorker(makerRef.current, sessionId, form, team.workers);
      setSheetView('collab');
      void refreshTeam();
    } catch (err) {
      setError(describeOrcaError(err, 'session.collab.errors.createFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, form, formValid, refreshTeam, sessionId, setSheetView, team.workers]);

  const runTeamAction = useCallback(async (action: () => Promise<unknown>, fallbackKey: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      void refreshTeam();
      return true;
    } catch (err) {
      setError(describeOrcaError(err, fallbackKey));
      void refreshTeam();
      return false;
    } finally {
      setBusy(false);
    }
  }, [refreshTeam]);

  const openWorker = useCallback((worker: OrcaTeamWorker) => {
    setSheetOpen(false);
    // 看到「已完成」即确认(对齐桌面:可见的 done Worker 自动 acknowledge);状态已变则忽略。
    if (worker.status === 'done') {
      void makerRef.current.orca.acknowledgeDone(sessionId, worker.workerId).catch(() => undefined);
    }
    openSession(worker.sessionId);
  }, [openSession, sessionId, setSheetOpen]);

  const confirmArchive = useCallback((worker: OrcaTeamWorker) => {
    Alert.alert(
      i18n.t('session.collab.archiveConfirmTitle', { name: orcaWorkerDisplayName(worker) }),
      i18n.t('session.collab.archiveConfirmDesc'),
      [
        { text: i18n.t('session.collab.cancel'), style: 'cancel' },
        {
          text: i18n.t('session.collab.archiveConfirm'),
          style: 'destructive',
          onPress: () => {
            void runTeamAction(
              () => makerRef.current.orca.archiveWorker(sessionId, worker.workerId),
              'session.collab.errors.archiveFailed',
            );
          },
        },
      ],
    );
  }, [runTeamAction, sessionId]);

  /** 点 Worker 行:打开 / 设为焦点 / 归档。 */
  const pressWorker = useCallback((worker: OrcaTeamWorker) => {
    Alert.alert(
      orcaWorkerDisplayName(worker),
      orcaWorkerStatusLabel(worker.status),
      [
        { text: i18n.t('session.collab.openWorker'), onPress: () => openWorker(worker) },
        ...(worker.focused ? [] : [{
          text: i18n.t('session.collab.setFocus'),
          onPress: () => {
            void runTeamAction(
              () => makerRef.current.orca.switchFocus(sessionId, worker.workerId),
              'session.collab.errors.switchFailed',
            );
          },
        }]),
        { text: i18n.t('session.collab.archive'), style: 'destructive' as const, onPress: () => confirmArchive(worker) },
        { text: i18n.t('session.collab.cancel'), style: 'cancel' as const },
      ],
    );
  }, [confirmArchive, openWorker, runTeamAction, sessionId]);

  const confirmEndTeam = useCallback(() => {
    Alert.alert(
      i18n.t('session.collab.stopConfirmTitle'),
      i18n.t('session.collab.stopConfirmDesc'),
      [
        { text: i18n.t('session.collab.cancel'), style: 'cancel' },
        {
          text: i18n.t('session.collab.stop'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const ok = await runTeamAction(
                () => makerRef.current.orca.disable(sessionId),
                'session.collab.errors.stopFailed',
              );
              if (!ok || !deviceId) return;
              remoteSessionStore.applySessionPatch(deviceId, sessionId, { orcaRole: null });
              setSheetView('main');
              setSheetOpen(false);
            })();
          },
        },
      ],
    );
  }, [deviceId, runTeamAction, sessionId, setSheetOpen, setSheetView]);

  const openLead = useCallback(() => {
    if (workerLeadSessionId) openSession(workerLeadSessionId);
  }, [openSession, workerLeadSessionId]);

  return {
    eligible,
    isLead,
    isWorker,
    entryHint: isLead ? null : orcaCollabEntryHint(entryStatus),
    entryBlocked: !isLead && entryStatus !== 'ready',
    team,
    workerLeadSessionId,
    openLead,
    workerForm,
    busy,
    error,
    canSubmit: workerForm.valid && !busy,
    openFromMain,
    openCreateWorker,
    submitEnable,
    submitCreate,
    pressWorker,
    confirmEndTeam,
  };
}
