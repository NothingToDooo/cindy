/**
 * 渠道默认跟随(channelDefaultRouteSync)在真 SQLite 上的读写:
 * 何时切、切完记录落什么、失败怎么回退、老任务怎么补记录。
 * 切换本身(register.ts 的路由选择)在这里是替身 —— 它的语义由伙伴模型对齐覆盖。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fingerprint: vi.fn(() => 'fp-new'),
  resolveDefaults: vi.fn(),
  listProviders: vi.fn(async () => [] as unknown[]),
  applyRoute: vi.fn(),
  readPendingRoute: vi.fn(() => undefined as unknown),
  cancelPending: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/never-used-here' },
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  maskPath: (p: string) => p,
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  setSessionProvider: vi.fn(),
}));
vi.mock('../../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: mocks.listProviders }),
}));
vi.mock('@cindy/model-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cindy/model-providers')>()),
  // 隐式来源一律落到 'xd' —— 足够验证「隐式 == 钉住的 xd」归一化。
  effectiveSourceIdForModel: vi.fn(() => 'xd'),
}));
vi.mock('../../defaultSessionSettings', () => ({
  getImDefaultEffortFor: vi.fn(() => 'high'),
  readImDefaultSettingsFingerprint: mocks.fingerprint,
  resolveImSessionDefaults: mocks.resolveDefaults,
}));
vi.mock('../../../maker-ipc/register', () => ({
  acquirePendingAgentSwitchForImSend: vi.fn(async (_id: string, sync: () => Promise<void>) => {
    await sync();
    return () => {};
  }),
  applySessionRouteUnderSendLock: mocks.applyRoute,
  readPendingAgentSwitchRoute: mocks.readPendingRoute,
  cancelPendingAgentSwitchForSession: mocks.cancelPending,
}));
vi.mock('../../../maker-ipc/sendToSessionLock', () => ({
  withSendToSessionLock: async <T>(_id: string, run: () => Promise<T>) => run(),
}));

let db: ReturnType<typeof drizzle>;
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: db }),
}));

const { sessions } = await import('../../../localDb/schema');
const {
  backfillLegacyImDefaultRoutes,
  createImChannelDefaultRouteSync,
  resetImSessionToChannelDefaults,
} = await import('../channelDefaultRouteSync');
const { buildImDefaultRouteRecord, parseImDefaultRouteRecord } = await import('../channelDefaultRoute');
import type { ImDefaultRoute } from '../channelDefaultRoute';
import type { ImOrchestratorConfig } from '../types';

const CONFIG = { agentKind: 'claude-code' } as ImOrchestratorConfig;
const OLD: ImDefaultRoute = { agentKind: 'claude-code', model: 'claude-opus-4-8', providerId: null, effort: 'xhigh' };
const NEW: ImDefaultRoute = { agentKind: 'codex', model: 'gpt-5.5', providerId: 'openai', effort: 'high' };

function createTableSql(): string {
  const config = getTableConfig(sessions);
  const cols = config.columns.map((col) => {
    const parts = [`"${col.name}"`, col.getSQLType()];
    if (col.primary) parts.push('PRIMARY KEY');
    if (col.notNull) parts.push('NOT NULL');
    const dflt = col.default;
    if (dflt !== undefined && typeof dflt !== 'object') {
      parts.push(`DEFAULT ${typeof dflt === 'string' ? `'${dflt}'` : Number(dflt)}`);
    }
    return parts.join(' ');
  });
  return `CREATE TABLE "${config.name}" (${cols.join(', ')})`;
}

function dbAgentKind(kind: ImDefaultRoute['agentKind']): string {
  return kind === 'claude-code' ? 'cc' : kind;
}

async function insertTask(
  id: string,
  route: ImDefaultRoute,
  opts: {
    source?: string;
    record?: string | null;
    remoteHostId?: string | null;
    marker?: boolean;
    status?: 'active' | 'archived';
  } = {},
): Promise<void> {
  const source = opts.source ?? 'feishu';
  const marker = opts.marker !== false;
  await db.insert(sessions).values({
    id,
    title: id,
    status: opts.status ?? 'active',
    agentKind: dbAgentKind(route.agentKind),
    model: route.model,
    providerId: route.providerId,
    effort: route.effort,
    permissionMode: 'auto',
    workingDir: '/tmp/im',
    source,
    remoteHostId: opts.remoteHostId ?? null,
    imDefaultRoute: opts.record === undefined ? buildImDefaultRouteRecord('fp-old', OLD) : opts.record,
    ...(source === 'feishu'
      ? marker ? { feishuBotAppId: 'cli_bot', feishuOpenId: 'ou_user' } : {}
      : marker ? { imBotContextId: 'bot', imUserId: 'user' } : {}),
    createdAt: 1,
    updatedAt: 1,
  } as typeof sessions.$inferInsert);
}

async function rowOf(id: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  return row!;
}

async function setRoute(id: string, route: ImDefaultRoute): Promise<void> {
  await db
    .update(sessions)
    .set({
      agentKind: dbAgentKind(route.agentKind),
      model: route.model,
      providerId: route.providerId,
      effort: route.effort as typeof sessions.$inferInsert.effort,
    })
    .where(eq(sessions.id, id));
}

function sync(isRouteUsable = vi.fn(async () => true)) {
  return createImChannelDefaultRouteSync({ source: 'feishu', config: CONFIG, isRouteUsable });
}

beforeEach(() => {
  vi.clearAllMocks();
  const raw = new Database(':memory:');
  raw.exec(createTableSql());
  db = drizzle(raw);
  mocks.fingerprint.mockReturnValue('fp-new');
  mocks.readPendingRoute.mockReturnValue(undefined);
  mocks.resolveDefaults.mockResolvedValue({ ...NEW, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-new' });
  mocks.applyRoute.mockImplementation(async (id: string, route: ImDefaultRoute) => {
    await setRoute(id, route);
    return 'applied';
  });
});

describe('syncUnderLock', () => {
  it('switches a following task and records the read-back route under the new fingerprint', async () => {
    await insertTask('t1', OLD);
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).toHaveBeenCalledWith('t1', { ...NEW, fastMode: false }, 'claude-code');
    const record = parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute);
    expect(record).toEqual({ v: 1, fp: 'fp-new', route: NEW });
  });

  it('records what actually landed when the switch re-routed the provider', async () => {
    await insertTask('t1', OLD);
    mocks.applyRoute.mockImplementation(async (id: string, route: ImDefaultRoute) => {
      await setRoute(id, { ...route, providerId: 'openai-copy' });
      return 'applied';
    });
    await sync().syncUnderLock('t1');

    const record = parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute);
    expect(record?.route.providerId).toBe('openai-copy');
  });

  it('keeps the old fingerprint and remembers the pending target while the runtime is busy', async () => {
    await insertTask('t1', OLD);
    mocks.applyRoute.mockResolvedValue('staged');
    await sync().syncUnderLock('t1');

    const record = parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute);
    expect(record).toEqual({ v: 1, fp: 'fp-old', route: OLD, pendingRoute: NEW, pendingFp: 'fp-new' });
  });

  it('remembers the staged intent as registered, then does not re-register it', async () => {
    await insertTask('t1', OLD);
    const rerouted: ImDefaultRoute = { ...NEW, providerId: 'openai-copy' };
    mocks.applyRoute.mockResolvedValue('staged');
    mocks.readPendingRoute.mockReturnValueOnce(undefined).mockReturnValue(rerouted);
    await sync().syncUnderLock('t1');

    expect(parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-old',
      route: OLD,
      pendingRoute: rerouted,
      pendingFp: 'fp-new',
    });
    // 下一条消息: 不重新登记, 只尝试应用自己登记的意图(仍忙 → 继续等)。
    mocks.applyRoute.mockClear();
    await sync().syncUnderLock('t1');
    expect(mocks.applyRoute).toHaveBeenCalledTimes(1);
    expect(mocks.applyRoute).toHaveBeenCalledWith('t1', null, 'claude-code');
    expect(parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute)?.pendingRoute).toEqual(rerouted);

    // 再下一条: 空闲了, 意图应用成功 → 记录读回的路由与新指纹。
    mocks.applyRoute.mockImplementationOnce(async (id: string) => {
      await setRoute(id, rerouted);
      return 'applied';
    });
    await sync().syncUnderLock('t1');
    expect(parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-new',
      route: rerouted,
    });
  });

  it('withdraws its staged intent without blocking when applying it fails', async () => {
    await insertTask('t1', OLD, {
      record: buildImDefaultRouteRecord('fp-old', OLD, { route: NEW, fp: 'fp-new' }),
    });
    mocks.readPendingRoute.mockReturnValue(NEW);
    mocks.applyRoute.mockRejectedValue(new Error('model window confirmation required'));
    await expect(sync().syncUnderLock('t1')).resolves.toBeUndefined();

    expect(mocks.applyRoute).toHaveBeenCalledWith('t1', null, 'claude-code');
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('leaves a task the user changed alone', async () => {
    await insertTask('t1', { ...OLD, model: 'claude-sonnet-5' });
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('treats a pinned native source as the recorded implicit default', async () => {
    await insertTask('t1', { ...OLD, providerId: 'xd' });
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).toHaveBeenCalled();
  });

  it('never blocks the message and restores the record when the switch fails', async () => {
    await insertTask('t1', OLD);
    mocks.applyRoute.mockRejectedValue(new Error('model window unknown'));
    await expect(sync().syncUnderLock('t1')).resolves.toBeUndefined();

    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
    expect((await rowOf('t1')).model).toBe(OLD.model);
  });

  it('keeps the current route when the new default is not usable', async () => {
    await insertTask('t1', OLD);
    await sync(vi.fn(async () => false)).syncUnderLock('t1');

    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('only adopts the new fingerprint when the task already runs the new default', async () => {
    await insertTask('t1', NEW);
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect(parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute)).toEqual({ v: 1, fp: 'fp-new', route: NEW });
  });

  it('does nothing while the settings fingerprint is unchanged', async () => {
    await insertTask('t1', OLD);
    mocks.fingerprint.mockReturnValue('fp-old');
    await sync().syncUnderLock('t1');

    expect(mocks.resolveDefaults).not.toHaveBeenCalled();
    expect(mocks.applyRoute).not.toHaveBeenCalled();
  });

  it.each([
    ['another channel', { source: 'telegram' }],
    ['a desktop task', { source: 'desktop' }],
    ['a remote task', { remoteHostId: 'ssh-1' }],
    ['a task without channel markers (official hook)', { marker: false }],
    ['an archived task', { status: 'archived' as const }],
    ['a task without a record', { record: null }],
  ])('ignores %s', async (_label, opts) => {
    await insertTask('t1', OLD, opts);
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).not.toHaveBeenCalled();
  });
});

describe('previewSwitchTarget', () => {
  it('returns the new default only when this message will switch to it', async () => {
    await insertTask('follow', OLD);
    await insertTask('manual', { ...OLD, model: 'claude-sonnet-5' });
    const s = sync();

    await expect(s.previewSwitchTarget('follow')).resolves.toEqual(NEW);
    await expect(s.previewSwitchTarget('manual')).resolves.toBeNull();
    await expect(sync(vi.fn(async () => false)).previewSwitchTarget('follow')).resolves.toBeNull();
    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect((await rowOf('follow')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });
});

describe('backfillLegacyImDefaultRoutes', () => {
  it('records only legacy tasks of this channel that still run the old default', async () => {
    mocks.resolveDefaults.mockResolvedValue({ ...OLD, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-old' });
    await insertTask('legacy-default', OLD, { record: null });
    await insertTask('legacy-pinned', { ...OLD, providerId: 'xd' }, { record: null });
    await insertTask('legacy-changed', { ...OLD, model: 'claude-sonnet-5' }, { record: null });
    await insertTask('legacy-other-channel', OLD, { record: null, source: 'telegram' });
    await insertTask('recorded', { ...OLD, model: 'claude-sonnet-5' });

    await expect(backfillLegacyImDefaultRoutes('feishu', CONFIG)).resolves.toBe(2);

    expect(parseImDefaultRouteRecord((await rowOf('legacy-default')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-old',
      route: OLD,
    });
    expect(parseImDefaultRouteRecord((await rowOf('legacy-pinned')).imDefaultRoute)?.route.providerId).toBe('xd');
    expect((await rowOf('legacy-changed')).imDefaultRoute).toBeNull();
    expect((await rowOf('legacy-other-channel')).imDefaultRoute).toBeNull();
    expect((await rowOf('recorded')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });
});

describe('resetImSessionToChannelDefaults', () => {
  it('writes the new route with its record and drops a stale pending switch', async () => {
    await insertTask('t1', { ...OLD, model: 'claude-sonnet-5' });
    mocks.readPendingRoute.mockReturnValue(NEW);
    await resetImSessionToChannelDefaults(
      't1',
      CONFIG,
      {
        id: 't1',
        agentKind: 'codex',
        workingDir: '/tmp/im',
        model: 'gpt-5.5',
        effort: 'high',
        permissionMode: 'auto',
        fastMode: false,
        sdkSessionId: null,
        providerId: 'openai',
        defaultRouteFingerprint: 'fp-new',
      },
      'feishu',
    );

    const row = await rowOf('t1');
    expect(row.model).toBe('gpt-5.5');
    expect(parseImDefaultRouteRecord(row.imDefaultRoute)).toEqual({ v: 1, fp: 'fp-new', route: NEW });
    expect(mocks.cancelPending).toHaveBeenCalledWith('t1');
  });
});

describe('createSession', () => {
  it('records the channel default it created the task from, and keeps a revived row as is', async () => {
    const { createImSessionRepo } = await import('../sessionRepo');
    mocks.resolveDefaults.mockResolvedValue({ ...NEW, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-new' });
    const ns = {
      source: 'feishu',
      sessionIdFor: (bot: string, user: string) => `feishu_${bot}_${user}`,
      defaultTitle: () => 'Feishu',
      ensureWorkingDir: () => '/tmp/im',
      extraInsertColumns: (bot: string, user: string) => ({ feishuBotAppId: bot, feishuOpenId: user }),
    } as unknown as Parameters<typeof createImSessionRepo>[1];
    const repo = createImSessionRepo(CONFIG, ns);

    const created = await repo.createSession('cli_bot', 'ou_user');
    expect(parseImDefaultRouteRecord((await rowOf(created.id)).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-new',
      route: NEW,
    });

    // 冲突(复活)分支不碰路由与记录 —— 残留行保留自己的设置。
    await db.update(sessions).set({ status: 'archived', imDefaultRoute: 'kept' }).where(eq(sessions.id, created.id));
    await repo.createSession('cli_bot', 'ou_user');
    expect((await rowOf(created.id)).imDefaultRoute).toBe('kept');
  });
});
