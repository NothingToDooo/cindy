/**
 * 用户单独改过路由的持久标记(脱离渠道默认跟随)。
 *
 * 「单独改过」按选择行为判定、不看取值: 用户经 `/model`、桌面或手机重选路由,
 * 即使选的恰与当前/默认同值, 任务此后也不再跟随渠道默认(greptile P1 补充,
 * PR #5155)。同值重选在路由值上无痕, 只能在**用户选择落地**时立墓碑
 * (`buildImManualRouteOverrideRecord`); `/new` 重置会用普通记录覆盖、重新跟随。
 *
 * 本模块保持叶子(只依赖 localDb 与纯逻辑), maker-ipc 与 IM 侧都能调用, 不引入
 * 循环依赖。只给渠道自有任务写 —— 其它任务没有跟随记录, 写了只是垃圾。
 */
import { eq } from 'drizzle-orm';

import { dbToMakerAgentKind } from '../../../shared/agentKindConversion.js';
import {
  IM_DEFAULT_SETTINGS_CHANNELS,
  type ImDefaultSettingsChannel,
} from '../../../shared/imDefaultSettings.js';
import { getDbClient } from '../../localDb/client/current';
import { sessions } from '../../localDb/schema';
import { createLogger } from '../../logger';
import { buildImManualRouteOverrideRecord, type ImDefaultRoute } from './channelDefaultRoute';

const log = createLogger('im:default-route');

export async function markImSessionManualRouteOverride(sessionId: string): Promise<void> {
  const [row] = await getDbClient()
    .drizzle.select({
      source: sessions.source,
      status: sessions.status,
      remoteHostId: sessions.remoteHostId,
      orcaRole: sessions.orcaRole,
      agentKind: sessions.agentKind,
      model: sessions.model,
      providerId: sessions.providerId,
      effort: sessions.effort,
      feishuBotAppId: sessions.feishuBotAppId,
      imBotContextId: sessions.imBotContextId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return;
  if (row.status !== 'active' || row.remoteHostId || row.orcaRole || !row.model) return;
  const source = row.source;
  if (!source || !IM_DEFAULT_SETTINGS_CHANNELS.includes(source as ImDefaultSettingsChannel)) return;
  if (source === 'feishu' ? !row.feishuBotAppId : !row.imBotContextId) return;
  const route: ImDefaultRoute = {
    agentKind: dbToMakerAgentKind(row.agentKind),
    model: row.model,
    providerId: row.providerId?.trim() || null,
    effort: row.effort ?? null,
  };
  await getDbClient()
    .drizzle.update(sessions)
    .set({ imDefaultRoute: buildImManualRouteOverrideRecord(route) })
    .where(eq(sessions.id, sessionId));
  log.info(
    `manual route override recorded session=...${sessionId.slice(-8)} ` +
      `(${route.agentKind}/${route.model}; stops following channel defaults)`,
  );
}
