import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  moved: false,
  generatedTitle: null as string | null,
}));

vi.mock('../../task-migration/writeBoundary', () => ({
  withTaskMigrationWrite: async (_id: string, write: () => Promise<unknown>) => {
    if (h.moved) throw new Error('MIGRATION_TASK_MOVED');
    return write();
  },
}));

vi.mock('../../maker-host/session-storage.js', () => ({
  desktopSessionStorage: { update: vi.fn() },
}));

vi.mock('../../maker-ipc/title.js', () => ({
  generateMakerSessionTitle: vi.fn(async () => h.generatedTitle),
}));

vi.mock('../shared/sessionBroadcast.js', () => ({
  broadcastSessionPatched: vi.fn(),
}));

import { generateMakerSessionTitle } from '../../maker-ipc/title.js';
import { desktopSessionStorage } from '../../maker-host/session-storage.js';
import { generateAndPersistFbotTitle, persistGeneratedSessionTitle, generateImSessionTitleText } from '../shared/fbotTitle.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.generatedTitle = null;
  h.moved = false;
});

describe('IM task title auxiliary model boundary', () => {
  it('delegates title generation to generateMakerSessionTitle', async () => {
    h.generatedTitle = '飞书会话标题';

    await expect(generateImSessionTitleText('task-1', '第一条消息')).resolves.toBe(
      '飞书会话标题',
    );
    expect(generateMakerSessionTitle).toHaveBeenCalledWith(
      '第一条消息',
      'claude-code',
      'task-1',
    );
  });

  it('returns null when generateMakerSessionTitle has no title', async () => {
    h.generatedTitle = null;

    await expect(generateImSessionTitleText('task-1', '第一条消息')).resolves.toBeNull();
  });
});

it('does not persist late generated or composed IM titles into a migrated task', async () => {
  h.generatedTitle = 'late title';
  h.moved = true;
  await expect(generateAndPersistFbotTitle('task-1', 'message')).rejects.toThrow('MIGRATION_TASK_MOVED');
  await expect(persistGeneratedSessionTitle('task-1', 'composed title')).rejects.toThrow('MIGRATION_TASK_MOVED');
  expect(desktopSessionStorage.update).not.toHaveBeenCalled();
});
