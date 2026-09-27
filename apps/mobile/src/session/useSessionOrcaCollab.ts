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
  convergeOrcaWorkerModel,
  createOrcaWorker,
  describeOrcaError,
  enableOrcaTeam,
  isOrcaCollabEligible,
  orcaAgentKindForSession,
  orcaCollabEntryHint,
  orcaWorkerFormFromPrefs,
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
  parseOrcaTeamWorkers,
  readOrcaTeamLeadSessionId,
  type OrcaCollaborationSettings,
} from '@cindy/maker-shared/orca-team';
import { subscribeRemoteOrcaWorkerChanged } from '@/device-link/DeviceLinkContext';
import { canSubmitOrcaWorkerForm, isPredefinedOrcaRole } from '@/session/ContextSheetCollabView';
import { normalizeMobileAgentCapabilities } from '@/session/agentCapabilities';
import {
  defaultOrcaWorkerCreationPrefs,
  readOrcaWorkerCreationPrefs,
  saveOrcaWorkerCreationPrefs,
  type OrcaWorkerCreationPrefs,
} from '@/session/orcaWorkerPrefs';
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
  /** 隧道重连代次:断线期间可能漏掉 worker-changed 推送,重连后整表重拉一次。 */
  connectionEpoch?: number;
}): OrcaTeamSnapshot & { refresh(): Promise<void> } {
  const { maker, deviceId, leadSessionId, connectionEpoch } = params;
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

  const seenEpochRef = useRef(connectionEpoch);
  useEffect(() => {
    if (seenEpochRef.current === connectionEpoch) return;
    seenEpochRef.current = connectionEpoch;
    void refresh();
  }, [connectionEpoch, refresh]);

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
  /** 隧道重连代次:首次查询赶上断线 / 瞬时失败时,重连后再查一次。 */
  connectionEpoch?: number;
}): string | null {
  const { maker, workerSessionId, connectionEpoch } = params;
  const [leadSessionId, setLeadSessionId] = useState<string | null>(null);
  const makerRef = useRef(maker);
  makerRef.current = maker;
  useEffect(() => {
    setLeadSessionId(null);
  }, [workerSessionId]);
  useEffect(() => {
    if (!workerSessionId) return undefined;
    let cancelled = false;
    makerRef.current.orca.getTeamByWorkerSession(workerSessionId)
      .then((team) => { if (!cancelled) setLeadSessionId(readOrcaTeamLeadSessionId(team)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [workerSessionId, connectionEpoch]);
  return leadSessionId;
}


/**
 * Worker 表单状态(与桌面 CreateWorkerPopover 同一套记忆规则,见 orcaWorkerPrefs):
 * 打开表单时恢复上次的 Agent 与该 Agent 的模型 / 推理强度 / Fast、权限;切 Agent 时带出
 * 该 Agent 上次的选择;提交成功后调用 remember() 写回。记住的模型在当前电脑上不可用时
 * 回落「默认」(交给被控端解析)。
 *
 * 模型选择器与 + 面板是两个 sheet(iOS 原生 sheet 不能叠开):选模型前收起面板,
 * 选择器完全收起后再展开面板回到表单。
 */
export function useOrcaWorkerForm(params: {
  maker: MobileMakerTransport;
  /** 记忆按登录账号隔离;null = 未登录,不读写记忆(用首次默认值)。 */
  prefsScope: string | null;
  active: boolean;
  setSheetOpen(open: boolean): void;
}) {
  const { maker, prefsScope, active, setSheetOpen } = params;
  const [form, setForm] = useState<OrcaWorkerFormValue>(() => {
    const defaults = defaultOrcaWorkerCreationPrefs();
    return orcaWorkerFormFromPrefs(defaults, defaults.lastAgent);
  });
  const [customRoleMode, setCustomRoleMode] = useState(false);
  const [agents, setAgents] = useState<readonly OrcaWorkerAgentKind[]>(ALL_AGENTS);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const makerRef = useRef(maker);
  makerRef.current = maker;
  const formRef = useRef(form);
  formRef.current = form;
  const prefsRef = useRef<OrcaWorkerCreationPrefs>(defaultOrcaWorkerCreationPrefs());
  const prefsLoadedRef = useRef(false);
  /** 本次复位后用户是否动过表单:动过就不再让迟到的记忆 / 能力结果覆盖用户的选择。 */
  const touchedRef = useRef(false);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const generationRef = useRef(0);

  const prefsScopeRef = useRef(prefsScope);
  prefsScopeRef.current = prefsScope;

  // 挂载 / 换账号时预读记忆,复位时即可同步恢复,不在用户操作期间异步覆盖表单。
  // 换账号时推进代次:上一个账号还在路上的读取 / 能力收敛一律作废,不写进新账号的表单。
  useEffect(() => {
    generationRef.current += 1;
    prefsLoadedRef.current = false;
    prefsRef.current = defaultOrcaWorkerCreationPrefs();
    if (!prefsScope) {
      prefsLoadedRef.current = true;
      return undefined;
    }
    let cancelled = false;
    void readOrcaWorkerCreationPrefs(prefsScope).then((prefs) => {
      if (cancelled) return;
      prefsRef.current = prefs;
      prefsLoadedRef.current = true;
    });
    return () => { cancelled = true; };
  }, [prefsScope]);


  /**
   * 按被控端能力收敛模型选择;能力读不到时保留原选择(提交时由被控端裁决)。
   * 只改模型字段,且结果迟到时(期间用户又改了模型 / Agent)按代次丢弃。
   */
  const converge = useCallback((agent: OrcaWorkerAgentKind, generation: number) => {
    makerRef.current.getCapabilities(agent)
      .then((raw) => {
        if (generation !== generationRef.current) return;
        const capabilities = normalizeMobileAgentCapabilities(raw);
        setForm((current) => (current.agent === agent
          ? { ...current, model: convergeOrcaWorkerModel(current.model, capabilities) }
          : current));
      })
      .catch(() => undefined);
  }, []);

  // 读被控端实际注册的 Agent。复位时列表可能还是乐观的三个:结果回来后,若用户还没动过
  // 表单且当前 Agent 不在这台电脑上,切到第一个可用 Agent 并带出它的记忆,避免提交必然失败。
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    makerRef.current.listAvailableAgents()
      .then((available) => {
        if (cancelled) return;
        const next = ALL_AGENTS.filter((agent) => available.includes(agent));
        if (next.length === 0) return;
        agentsRef.current = next;
        setAgents(next);
        if (touchedRef.current || next.includes(formRef.current.agent)) return;
        const generation = ++generationRef.current;
        const switched = next[0]!;
        const remembered = prefsRef.current.agents[switched];
        setForm((current) => ({
          ...current,
          agent: switched,
          model: { id: remembered.model, providerId: null, effort: remembered.effort, fast: remembered.fast },
        }));
        converge(switched, generation);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, converge, maker]);

  /** 重新打开已确认的表单(新建任务的协同草稿):角色模式跟随保存的角色,不沿用上次未提交的编辑。 */
  const restore = useCallback((value: OrcaWorkerFormValue) => {
    generationRef.current += 1;
    touchedRef.current = true;
    setCustomRoleMode(!isPredefinedOrcaRole(value.role.trim().toLowerCase()));
    setForm(value);
  }, []);

  /** 恢复记忆(上次的 Agent 不在当前电脑上时取第一个可用 Agent)。初始任务不记忆。 */
  const reset = useCallback(() => {
    const generation = ++generationRef.current;
    touchedRef.current = false;
    setCustomRoleMode(false);
    const apply = (prefs: OrcaWorkerCreationPrefs) => {
      const available = agentsRef.current;
      const agent = available.includes(prefs.lastAgent) ? prefs.lastAgent : available[0] ?? prefs.lastAgent;
      setForm(orcaWorkerFormFromPrefs(prefs, agent));
      converge(agent, generation);
    };
    apply(prefsRef.current);
    // 预读尚未完成(极少见:刚登录就打开表单):读完后仅在用户还没动过这张表单时补一次。
    if (!prefsLoadedRef.current && prefsScope) {
      const scope = prefsScope;
      void readOrcaWorkerCreationPrefs(scope).then((prefs) => {
        if (prefsScopeRef.current !== scope) return;
        prefsRef.current = prefs;
        prefsLoadedRef.current = true;
        if (generation !== generationRef.current || touchedRef.current) return;
        apply(prefs);
      });
    }
  }, [converge, prefsScope]);

  /** 切 Agent:带出该 Agent 上次的模型 / 推理强度 / Fast(对齐桌面)。 */
  const changeAgent = useCallback((agent: OrcaWorkerAgentKind) => {
    touchedRef.current = true;
    const generation = ++generationRef.current;
    const remembered = prefsRef.current.agents[agent];
    setForm((current) => ({
      ...current,
      agent,
      model: { id: remembered.model, providerId: null, effort: remembered.effort, fast: remembered.fast },
    }));
    converge(agent, generation);
  }, [converge]);

  /** 提交成功后写回记忆(与桌面一样只在提交时记)。 */
  const remember = useCallback((submitted: OrcaWorkerFormValue) => {
    const previous = prefsRef.current;
    const next: OrcaWorkerCreationPrefs = {
      ...previous,
      lastAgent: submitted.agent,
      workerPermissionMode: submitted.permissionMode,
      agents: submitted.model
        ? {
          ...previous.agents,
          [submitted.agent]: {
            model: submitted.model.id,
            effort: submitted.model.effort ?? previous.agents[submitted.agent].effort,
            fast: submitted.model.fast,
          },
        }
        : previous.agents,
    };
    prefsRef.current = next;
    if (prefsScope) saveOrcaWorkerCreationPrefs(prefsScope, next);
  }, [prefsScope]);

  const patch = useCallback((next: Partial<OrcaWorkerFormValue>) => {
    touchedRef.current = true;
    setForm((current) => ({ ...current, ...next }));
  }, []);

  const changePermission = useCallback(async (mode: OrcaWorkerPermissionMode) => {
    touchedRef.current = true;
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
    touchedRef.current = true;
    generationRef.current += 1;
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
    restore,
    customRoleMode,
    setCustomRoleMode,
    patch,
    changeAgent,
    changePermission,
    agents,
    pickerAgents,
    valid: canSubmitOrcaWorkerForm(form, customRoleMode),
    reset,
    remember,
    modelPicker: { open: modelPickerOpen, openPicker, close, closed, select },
  };
}

export function useSessionOrcaCollab(params: {
  maker: MobileMakerTransport;
  deviceId: string | null;
  sessionId: string;
  session: RemoteSession | null;
  /** Worker 创建偏好的记忆范围(按区域限定的账号键 accountKey);null = 不记忆。 */
  prefsScope: string | null;
  /** 隧道重连代次(会话页的 connectionEpoch):重连后补拉团队与 Worker 所属 Lead。 */
  connectionEpoch?: number;
  /** 共享任务访客 / 宿主托管任务不提供协同编排(不拉团队、不挂入口)。 */
  enabled: boolean;
  /** + 面板当前是否展示协同视图。 */
  sheetView: CollabSheetView | null;
  sheetOpen: boolean;
  setSheetView(view: 'main' | CollabSheetView): void;
  setSheetOpen(open: boolean): void;
  openSession(sessionId: string): void;
}) {
  const { maker, deviceId, sessionId, session, prefsScope, connectionEpoch, enabled, sheetView, sheetOpen, setSheetView, setSheetOpen, openSession } = params;
  const role = enabled ? session?.orcaRole ?? null : null;
  const isLead = role === 'lead';
  const isWorker = role === 'worker';
  const eligible = enabled && (isLead || isOrcaCollabEligible(session));
  const team = useOrcaTeam({ maker, deviceId, leadSessionId: isLead ? sessionId : null, connectionEpoch });
  const workerLeadSessionId = useOrcaWorkerLeadSessionId({
    maker,
    workerSessionId: isWorker ? sessionId : null,
    connectionEpoch,
  });
  const workerForm = useOrcaWorkerForm({
    maker,
    prefsScope,
    active: sheetOpen && sheetView !== null,
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
  // 重连后重读:断线时读失败会落成「不可用」,不能让已打开的表单一直卡住。
  useEffect(() => {
    const current = sessionRef.current;
    if (!sheetOpen || !eligible || !current) return undefined;
    let cancelled = false;
    setEntryStatus('loading');
    void readOrcaCollabEntryStatus(makerRef.current, current, orcaAgentKindForSession(current))
      .then((status) => { if (!cancelled) setEntryStatus(status); });
    return () => { cancelled = true; };
  }, [sheetOpen, eligible, sessionId, role, connectionEpoch]);

  // 协同视图展示中时顺带刷新一次团队(推送之外的兜底)。
  const refreshTeam = team.refresh;
  useEffect(() => {
    if (sheetOpen && sheetView === 'collab' && isLead) void refreshTeam();
  }, [sheetOpen, sheetView, isLead, refreshTeam]);

  const resetWorkerForm = workerForm.reset;
  const rememberWorkerForm = workerForm.remember;
  /** + 面板主视图的「协同模式」行:Lead 进团队面板,其它进开启表单。 */
  const openFromMain = useCallback(() => {
    setError(null);
    if (!isLead) resetWorkerForm();
    setSheetView('collab');
  }, [isLead, resetWorkerForm, setSheetView]);

  const openCreateWorker = useCallback(() => {
    setError(null);
    resetWorkerForm();
    setSheetView('collab-create');
  }, [resetWorkerForm, setSheetView]);

  const form = workerForm.form;
  const formValid = workerForm.valid;

  const submitEnable = useCallback(async () => {
    if (!deviceId || !formValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await enableOrcaTeam(makerRef.current, sessionId, buildOrcaEnableOptions(form, form.initialTask));
      rememberWorkerForm(form);
      remoteSessionStore.applySessionPatch(deviceId, sessionId, { orcaRole: 'lead' });
      setSheetView('collab');
      void refreshTeam();
    } catch (err) {
      setError(describeOrcaError(err, 'session.collab.errors.startFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, deviceId, form, formValid, refreshTeam, rememberWorkerForm, sessionId, setSheetView]);

  const submitCreate = useCallback(async () => {
    if (!formValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createOrcaWorker(makerRef.current, sessionId, form, team.workers);
      rememberWorkerForm(form);
      setSheetView('collab');
      void refreshTeam();
    } catch (err) {
      setError(describeOrcaError(err, 'session.collab.errors.createFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, form, formValid, refreshTeam, rememberWorkerForm, sessionId, setSheetView, team.workers]);

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

  /**
   * 点 Worker 行:打开 / 设为焦点 / 归档。Android 原生 Alert 最多三个按钮,所以每一层
   * 都控制在三个以内:已是焦点时「打开 / 归档 / 取消」;否则「打开 / 更多 / 取消」,
   * 「更多」再给「设为焦点 / 归档 / 取消」。
   */
  const pressWorker = useCallback((worker: OrcaTeamWorker) => {
    const name = orcaWorkerDisplayName(worker);
    const cancel = { text: i18n.t('session.collab.cancel'), style: 'cancel' as const };
    const open = { text: i18n.t('session.collab.openWorker'), onPress: () => openWorker(worker) };
    const archive = {
      text: i18n.t('session.collab.archive'),
      style: 'destructive' as const,
      onPress: () => confirmArchive(worker),
    };
    if (worker.focused) {
      Alert.alert(name, orcaWorkerStatusLabel(worker.status), [open, archive, cancel]);
      return;
    }
    const setFocus = {
      text: i18n.t('session.collab.setFocus'),
      onPress: () => {
        void runTeamAction(
          () => makerRef.current.orca.switchFocus(sessionId, worker.workerId),
          'session.collab.errors.switchFailed',
        );
      },
    };
    Alert.alert(name, orcaWorkerStatusLabel(worker.status), [
      open,
      { text: i18n.t('session.collab.moreActions'), onPress: () => Alert.alert(name, undefined, [setFocus, archive, cancel]) },
      cancel,
    ]);
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
