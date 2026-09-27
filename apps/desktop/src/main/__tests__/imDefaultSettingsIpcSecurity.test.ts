import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');

describe('im default settings IPC security contract', () => {
  // 保存/重置会按旧默认批量补写老任务的跟随记录, 并让下一条 IM 消息切换现有任务的
  // 运行路由 —— sender 校验必须拦在任何回填或写设置之前, 不能让导航到外部页面的
  // preload frame 改写渠道默认并推动任务切路由(codex review P1, PR #5155)。
  it.each([
    ['IM_DEFAULT_SETTINGS_SET', 'writeImDefaultSettingsPatch('],
    ['IM_DEFAULT_SETTINGS_RESET', 'resetImDefaultSettings'],
  ] as const)('guards %s before any backfill or settings write', (channel, writeCall) => {
    const handler = source.indexOf(`MAKER_IPC_INVOKE.${channel},`);
    expect(handler).toBeGreaterThanOrEqual(0);
    const guard = source.indexOf('assertTrustedAppRendererEvent(event);', handler);
    const backfill = source.indexOf('prepareImDefaultSettingsChange(', handler);
    const write = source.indexOf(writeCall, handler);
    expect(guard).toBeGreaterThan(handler);
    expect(backfill).toBeGreaterThan(guard);
    expect(write).toBeGreaterThan(guard);
  });
});
