/**
 * 手机端 Orca 协同编排:入口可用性、团队状态订阅与写操作。
 *
 * Lead / Worker / team 的真身都在被控端 main,手机只是镜像 + 编排入口(与桌面 device-link
 * 控制端同一组 channel,见 mobileMakerTransport 的 `orca` 组)。几条不变量:
 *  - 入口判定 fail-closed:被控端不声明 `supportsOrcaWorkerPermissionMode`、或协同插件查询
 *    CHANNEL_NOT_ALLOWED,一律按「设备版本过旧」置灰,不放行到 enable-orca 才撞错。
 *  - 写操作不自动重试;enable-orca 隧道超时不是权威失败 —— 先回查被控端 Worker 列表再定性
 *    (与桌面 remoteCollabHandoff 同口径),查不到才按失败处理。
 *  - 团队列表以被控端为准:`maker:orca:worker-changed` 推送或写操作完成后整表重拉。
 */
import {
  createWorkerLabel,
  parseOrcaTeamWorkers,
  readOrcaCollabPolicy,
  type OrcaCollaborationSettings,
  type OrcaTeamWorker,
  type OrcaWorkerAgentKind,
  type OrcaWorkerPermissionMode,
} from '@cindy/maker-shared/orca-team';
import { formatRemoteError, isTransientRemoteError } from '@cindy/maker-shared/device-link-contract';
import { normalizeMobileAgentCapabilities } from '@/session/agentCapabilities';
import { humanizeRemoteError } from '@/device-link/remoteStatus';
import { i18n } from '@/i18n';
import type {
  MobileMakerTransport,
  MobileOrcaEnableOptions,
} from '@/device-link/mobileMakerTransport';
import type { RemoteSession } from '@/session/types';
import type { MobileAgentCapabilities } from '@/session/agentCapabilities';
import type { OrcaWorkerCreationPrefs } from '@/session/orcaWorkerPrefs';

export type { OrcaTeamWorker, OrcaCollaborationSettings, OrcaWorkerAgentKind, OrcaWorkerPermissionMode };

/** 创建 Worker 表单(开启协同与追加 Worker 共用)。 */
export interface OrcaWorkerFormValue {
  role: string;
  agent: OrcaWorkerAgentKind;
  /** null = 跟随被控端默认(该 Agent 上次新建任务的选择,回落 Lead 模型)。 */
  model: { id: string; providerId: string | null; effort: string | null; fast: boolean } | null;
  permissionMode: OrcaWorkerPermissionMode;
  initialTask: string;
}

export function orcaAgentKindForSession(session: Pick<RemoteSession, 'agentKind'>): OrcaWorkerAgentKind {
  return session.agentKind === 'codex' || session.agentKind === 'pi' ? session.agentKind : 'claude-code';
}

/** 由记忆构造表单:角色回到 developer,初始任务不记忆(与桌面一致)。 */
export function orcaWorkerFormFromPrefs(
  prefs: OrcaWorkerCreationPrefs,
  agent: OrcaWorkerAgentKind,
): OrcaWorkerFormValue {
  const remembered = prefs.agents[agent];
  return {
    role: 'developer',
    agent,
    model: { id: remembered.model, providerId: null, effort: remembered.effort, fast: remembered.fast },
    permissionMode: prefs.workerPermissionMode,
    initialTask: '',
  };
}

/**
 * 按被控端能力收敛模型选择(对齐桌面「加载能力后把选择收敛到可用模型和 effort」):
 * 模型不在该电脑的可用列表 → 回落「默认」(null,交给被控端解析);effort 不在档位表 →
 * 该模型默认档;模型不支持 Fast → 关 Fast。能力未知(null)时保持原样。
 */
export function convergeOrcaWorkerModel(
  model: OrcaWorkerFormValue['model'],
  capabilities: Pick<MobileAgentCapabilities, 'availableModels' | 'hasFastMode'> | null,
): OrcaWorkerFormValue['model'] {
  if (!model || !capabilities) return model;
  const option = capabilities.availableModels.find((item) => item.id === model.id);
  if (!option) return null;
  const effort = model.effort && option.efforts.includes(model.effort)
    ? model.effort
    : option.defaultEffort ?? option.efforts[0] ?? null;
  return {
    ...model,
    effort,
    fast: model.fast && option.supportsFastMode && capabilities.hasFastMode,
  };
}

/** 表单 → 被控端 enable-orca / worker:create 的共同字段。 */
function formWireFields(form: OrcaWorkerFormValue) {
  const model = form.model;
  return {
    ...(model ? { model: model.id } : {}),
    ...(model?.effort ? { effort: model.effort } : {}),
    ...(model?.fast ? { fast: true } : {}),
    ...(model?.providerId ? { providerId: model.providerId } : {}),
    workerPermissionMode: form.permissionMode,
  };
}

export function buildOrcaEnableOptions(
  form: OrcaWorkerFormValue,
  delegateTask?: string,
): MobileOrcaEnableOptions {
  const role = form.role.trim() || 'developer';
  const task = delegateTask?.trim();
  return {
    workerAgent: form.agent,
    role,
    label: createWorkerLabel(role, []),
    ...formWireFields(form),
    ...(task ? { delegateTask: task } : {}),
  };
}

// ─── 错误文案 ────────────────────────────────────────────────────────────────

const ORCA_ERROR_CODES = [
  'WORKER_LIMIT_HARD_EXCEEDED',
  'NO_PROVIDER_FOR_AGENT',
  'PROVIDER_ROUTE_UNAVAILABLE',
  'BUDGET_MODEL_REQUIRES_API_MODE',
  'INVALID_PARAMS',
  'PRECONDITION_FAILED',
  'WORKER_CREATION_IN_PROGRESS',
  'WORKER_NOT_FOUND',
  'ORCA_CREATE_UNCONFIRMED',
] as const;

export function isOrcaUnsupportedError(error: unknown): boolean {
  return formatRemoteError(error).includes('CHANNEL_NOT_ALLOWED');
}

export function isOrcaDuplicateLabelError(error: unknown): boolean {
  return formatRemoteError(error).includes('DUPLICATE_LABEL');
}

function isAmbiguousTimeout(error: unknown): boolean {
  const text = formatRemoteError(error);
  return text.includes('INVOKE_TIMEOUT') || text.includes('REQUEST_TIMEOUT') || text.includes('DEVICE_LINK_TIMEOUT');
}

/**
 * 协同写操作失败 → 界面语言文案(已知错误码精确映射,其余走通用远程错误)。
 * fallbackKey 是未知错误时的动作前缀(如「开启协同失败。」);外层文案已说明动作时传 null。
 */
export function describeOrcaError(error: unknown, fallbackKey: string | null): string {
  if (isOrcaUnsupportedError(error)) return i18n.t('session.collab.errors.unsupported');
  const text = formatRemoteError(error);
  const code = ORCA_ERROR_CODES.find((candidate) => text.includes(candidate));
  if (code) return i18n.t(`session.collab.errors.${code}`);
  const generic = humanizeRemoteError(error);
  return fallbackKey ? `${i18n.t(fallbackKey)}${generic ? ` ${generic}` : ''}` : generic;
}

// ─── 入口可用性 ──────────────────────────────────────────────────────────────

export type OrcaCollabEntryStatus =
  | 'ineligible'
  | 'loading'
  | 'ready'
  | 'disabled'
  | 'unsupported'
  | 'unavailable';

/** 能否挂协同入口(与桌面 resolveCollabEntryPolicy 同口径):Worker 子任务不能嵌套协同。 */
export function isOrcaCollabEligible(
  session: Pick<RemoteSession, 'orcaRole' | 'workspaceKind' | 'workingDir'> | null,
): boolean {
  if (!session || session.orcaRole === 'worker') return false;
  if (session.workspaceKind === 'dialogue') return true;
  return session.workspaceKind === 'project' && !!session.workingDir?.trim();
}

/**
 * 读被控端的协同入口状态:能力声明 + 协同插件开关。已经是 Lead 的任务不再查插件开关
 * (团队已存在,管理操作由被控端逐次授权)。
 */
export async function readOrcaCollabEntryStatus(
  maker: MobileMakerTransport,
  session: Pick<RemoteSession, 'orcaRole' | 'workspaceKind' | 'workingDir' | 'remoteHostId'>,
  agent: OrcaWorkerAgentKind,
): Promise<Exclude<OrcaCollabEntryStatus, 'loading'>> {
  if (!isOrcaCollabEligible(session)) return 'ineligible';
  let capabilities;
  try {
    capabilities = normalizeMobileAgentCapabilities(await maker.getCapabilities(agent));
  } catch (error) {
    return isOrcaUnsupportedError(error) ? 'unsupported' : 'unavailable';
  }
  if (capabilities?.supportsOrcaWorkerPermissionMode !== true) return 'unsupported';
  if (session.orcaRole === 'lead') return 'ready';
  const workingDir = session.remoteHostId ? undefined : session.workingDir?.trim() || undefined;
  try {
    const policy = readOrcaCollabPolicy(
      await maker.orca.getCollabPolicy(workingDir, session.workspaceKind),
      session.workspaceKind,
    );
    if (policy.unsupported) return 'unsupported';
    return policy.enabled ? 'ready' : 'disabled';
  } catch (error) {
    return isOrcaUnsupportedError(error) ? 'unsupported' : 'unavailable';
  }
}

export function orcaCollabEntryHint(status: OrcaCollabEntryStatus): string | null {
  switch (status) {
    case 'loading': return i18n.t('session.collab.loadingHint');
    case 'disabled': return i18n.t('session.collab.disabledHint');
    case 'unsupported': return i18n.t('session.collab.errors.unsupported');
    case 'unavailable': return i18n.t('session.collab.unavailableHint');
    default: return null;
  }
}

// ─── 写操作 ──────────────────────────────────────────────────────────────────

const TIMEOUT_RECOVERY_ATTEMPTS = 4;
const TIMEOUT_RECOVERY_DELAY_MS = 3000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 开启协同。mutation 前重读能力(弹窗展示时的快照可能已随重连降级);隧道超时后回查
 * 被控端 Worker 列表 —— 非空即团队已提交,按成功返回;查不到才把原始超时抛出。
 */
/**
 * 创建 Worker 前重读被控端能力:老被控端会忽略 workerPermissionMode、按它自己的默认权限
 * 建 Worker(可能是完全访问),与用户在手机上选的不符 —— 一律 fail-closed。
 */
async function assertWorkerPermissionSupported(
  maker: MobileMakerTransport,
  agent: OrcaWorkerAgentKind,
): Promise<void> {
  const capabilities = normalizeMobileAgentCapabilities(await maker.getCapabilities(agent));
  if (capabilities?.supportsOrcaWorkerPermissionMode !== true) {
    throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] controlled device does not support Orca Worker permission mode');
  }
}

/** 隧道超时后按被控端 Worker 列表回查;predicate 命中即说明写操作已提交。 */
async function probeCommittedWorker(
  maker: MobileMakerTransport,
  leadSessionId: string,
  predicate: (worker: OrcaTeamWorker) => boolean,
): Promise<OrcaTeamWorker | null> {
  for (let attempt = 0; attempt < TIMEOUT_RECOVERY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(TIMEOUT_RECOVERY_DELAY_MS);
    try {
      const match = parseOrcaTeamWorkers(await maker.orca.listWorkers(leadSessionId)).find(predicate);
      if (match) return match;
    } catch (probeError) {
      if (!isTransientRemoteError(probeError)) return null;
    }
  }
  return null;
}

export async function enableOrcaTeam(
  maker: MobileMakerTransport,
  leadSessionId: string,
  options: MobileOrcaEnableOptions,
): Promise<{ workerSessionId: string | null }> {
  await assertWorkerPermissionSupported(maker, options.workerAgent);
  try {
    const result = await maker.orca.enable(leadSessionId, options);
    return { workerSessionId: typeof result?.workerSessionId === 'string' ? result.workerSessionId : null };
  } catch (error) {
    // 隧道超时不代表被控端没执行;ALREADY_EXISTS 说明已有团队(另一端刚开启 / 管线重跑),
    // 但团队先于首个 Worker 落库,并发开启时首个 Worker 仍可能失败。两种都以被控端的
    // Worker 列表为准:有 Worker 才算开启成功,查不到按原错误处理。
    const alreadyExists = formatRemoteError(error).includes('ALREADY_EXISTS');
    if (!alreadyExists && !isAmbiguousTimeout(error)) throw error;
    const committed = await probeCommittedWorker(maker, leadSessionId, () => true);
    if (committed) return { workerSessionId: committed.sessionId };
    throw error;
  }
}

/**
 * 追加 Worker:label 按现有团队派生,撞 DUPLICATE_LABEL(并发创建)时重拉一次后重试。
 * 隧道超时不是权威失败:按本次请求的确切 label 回查被控端,查到即成功;查不到抛
 * ORCA_CREATE_UNCONFIRMED,提示用户先看 Worker 列表,不让「超时→重试」建出第二个。
 */
export async function createOrcaWorker(
  maker: MobileMakerTransport,
  leadSessionId: string,
  form: OrcaWorkerFormValue,
  existingWorkers: readonly OrcaTeamWorker[],
): Promise<{ workerSessionId: string | null }> {
  await assertWorkerPermissionSupported(maker, form.agent);
  const role = form.role.trim() || 'developer';
  const submit = async (labels: readonly string[]) => {
    const label = createWorkerLabel(role, labels);
    try {
      const result = await maker.orca.createWorker({
        leadSessionId,
        role,
        label,
        agent: form.agent,
        ...formWireFields(form),
        ...(form.initialTask.trim() ? { initialTask: form.initialTask.trim() } : {}),
      });
      return typeof result?.workerSessionId === 'string' ? result.workerSessionId : null;
    } catch (error) {
      if (!isAmbiguousTimeout(error)) throw error;
      const committed = await probeCommittedWorker(
        maker,
        leadSessionId,
        (worker) => worker.label?.toLowerCase() === label,
      );
      if (committed) return committed.sessionId;
      throw new Error('[ORCA_CREATE_UNCONFIRMED] worker creation timed out and could not be confirmed');
    }
  };
  const labelsOf = (workers: readonly OrcaTeamWorker[]) =>
    workers.map((worker) => worker.label).filter((label): label is string => !!label);
  try {
    return { workerSessionId: await submit(labelsOf(existingWorkers)) };
  } catch (error) {
    if (!isOrcaDuplicateLabelError(error)) throw error;
    const fresh = parseOrcaTeamWorkers(await maker.orca.listWorkers(leadSessionId));
    return { workerSessionId: await submit(labelsOf(fresh)) };
  }
}

// ─── 新建任务开启协同失败的跨页提示 ──────────────────────────────────────────
// 新建页在后台管线里开启协同;失败时任务照单任务继续,提示要在跳转后的会话页出现。
const orcaStartFailures = new Map<string, string>();

export function rememberOrcaStartFailure(sessionId: string, message: string): void {
  orcaStartFailures.set(sessionId, message);
}

export function takeOrcaStartFailure(sessionId: string): string | null {
  const message = orcaStartFailures.get(sessionId) ?? null;
  orcaStartFailures.delete(sessionId);
  return message;
}

export function orcaWorkerStatusLabel(status: OrcaTeamWorker['status']): string {
  return i18n.t(`session.collab.status.${status}`);
}

export function orcaWorkerDisplayName(worker: Pick<OrcaTeamWorker, 'role' | 'label'>): string {
  return worker.label && worker.label !== worker.role ? `${worker.role} #${worker.label}` : worker.role;
}

export function orcaAgentLabel(agent: OrcaWorkerAgentKind): string {
  return agent === 'codex' ? 'Codex' : agent === 'pi' ? 'Pi' : 'Claude Code';
}
