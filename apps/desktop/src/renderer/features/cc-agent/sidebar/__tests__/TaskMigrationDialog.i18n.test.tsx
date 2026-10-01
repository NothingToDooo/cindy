// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import type { Session } from '@/lib/ccAgent.types';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { TaskMigrationDialog } from '../TaskMigrationDialog';

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    captureSessionRead: () => Object.assign(() => true, { mergeActivity: (row: unknown) => row }),
    mergeDeviceSessions: vi.fn(),
  },
}));

const source = { id: 'task', title: 'Task', status: 'active', deviceLinkDeviceId: 'A' } as Session;
let failure = '';
let failurePath: string | undefined;
beforeEach(() => {
  failurePath = undefined;
  setDataOwnerGeneration('owner');
  Object.assign(window, {
    electronAPI: {
      deviceLink: {
        // A copy that stopped with an error, as the source reports it after a failure.
        taskMigration: async (device: string | null, command: { action: string }) => ({
          supported: true,
          deviceId: device ?? 'local',
          ...(command.action === 'status'
            ? {
                stage: 'preparing',
                running: false,
                error: failure,
                ...(failurePath ? { errorPath: failurePath } : {}),
                targetDeviceId: 'B',
                targetSessionId: 'migrated',
              }
            : {}),
        }),
        invoke: vi.fn(),
        openLink: vi.fn(),
        listDevices: async () => ({ devices: [] }),
      },
    },
  });
});
afterEach(cleanup);

const resources = [
  ['en', en],
  ['zh-CN', zhCN],
  ['zh-TW', zhTW],
  ['ja', ja],
  ['ko', ko],
] as const;

async function mount(locale: string, resource: object) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: locale,
    resources: { [locale]: { translation: resource } },
    interpolation: { escapeValue: false },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <TaskMigrationDialog session={source} onDismiss={() => {}} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

it.each(resources)(
  'keeps the code of an error without dedicated copy visible in %s',
  async (locale, resource) => {
    failure = 'MIGRATION_SNAPSHOT_MISSING';
    await mount(locale, resource);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      resource.taskMigration.failed.replace('{{code}}', 'MIGRATION_SNAPSHOT_MISSING'),
    );
  },
);

it.each(resources)('explains a workspace change during packing in %s', async (locale, resource) => {
  failure = 'MIGRATION_WORKSPACE_CHANGED';
  await mount(locale, resource);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(resource.taskMigration.errors.MIGRATION_WORKSPACE_CHANGED);
  expect(alert.textContent).not.toContain('MIGRATION_');
});

it.each(resources)('names the blocking project entry in %s', async (locale, resource) => {
  failure = 'MIGRATION_NONPORTABLE_PATH';
  failurePath = 'apps/desktop/C:';
  await mount(locale, resource);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(
    resource.taskMigration.errors.MIGRATION_NONPORTABLE_PATH +
      resource.taskMigration.errorPath.replace('{{path}}', 'apps/desktop/C:'),
  );
});
