// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ invoke: vi.fn(), submit: vi.fn(), openLink: vi.fn(), created: vi.fn() }));
vi.mock('react-native', () => ({
  StyleSheet: { create: (v: unknown) => v }, View: 'div', ScrollView: 'div',
  Pressable: ({ onPress, children }: any) => createElement('button', { onClick: onPress }, children),
  Switch: ({ accessibilityLabel, value, disabled, onValueChange }: any) => createElement('input', { type: 'checkbox', 'aria-label': accessibilityLabel, checked: value, disabled, onChange: (e: any) => onValueChange(e.target.checked) }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-request-12345' }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink }) }));
vi.mock('@/device-link/remoteResources', () => ({ invokeRemoteResourceAction: (...args: unknown[]) => h.submit(...args) }));
vi.mock('@/components/AppText', () => ({ Text: 'span', TextInput: ({ value }: any) => createElement('input', { value, readOnly: true }) }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => createElement('button', { onClick: action.onPress, disabled: action.disabled }, action.label) }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: ({ children }: any) => children }));
vi.mock('@/session/CompanionPortraitPicker', () => ({ randomCompanionPortrait: async () => 'original-portrait', CompanionPortraitPicker: ({ onChange }: any) => createElement('button', { onClick: () => onChange('chosen-existing-portrait') }, 'existing portrait picker') }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useThemedStyles: () => ({}) }));
import { CompanionImportSheet } from '@/session/CompanionImportSheet';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.clearAllMocks(); });
it('uses the existing portrait picker and sends only the remaining selections through the host resource', async () => {
  let imported = false;
  const result = { requestId: 'fixture-request-12345', botId: 'bot', canonicalSessionId: 'chat', status: 'complete', checks: [] };
  h.invoke.mockImplementation(async (_host: string, _channel: string, args: any[]) => {
    const id = args[0].ref.id;
    return { blocks: [{ primitive: 'companion-import', data: id === 'sources' ? { sources: [{ id: 'source', name: 'Ada', kind: 'hermes' }] } : id.startsWith('preview:') ? { preview: { id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [
      { id: 'personality', name: 'SOUL.md', category: 'personality', selected: true },
      { id: 'memory', name: 'USER.md', category: 'memory', selected: true },
      { id: 'unused', name: 'unused', category: 'skills', selected: false },
    ] } } : { result: imported ? result : null } }] };
  });
  h.submit.mockImplementation(async () => { imported = true; return { effects: [] }; });
  const container = document.createElement('div'); root = createRoot(container);
  await act(async () => root!.render(createElement(CompanionImportSheet, { visible: true, deviceId: 'host', deviceName: 'Mac', online: true, onClose() {}, onCreated: h.created })));
  const click = async (text: string) => { await act(async () => { const button = [...container.querySelectorAll('button')].find(button => button.textContent === text); expect(button).toBeDefined(); button!.click(); }); };
  await click('Ada · Hermes');
  await click('existing portrait picker');
  await act(async () => (container.querySelector('[aria-label="devices.companionImport.memory"]') as HTMLInputElement).click());
  await click('devices.companionImport.submit');
  expect(h.submit.mock.calls[0]?.[2].input).toMatchObject({ entryIds: ['personality'], avatarImageBase64: 'chosen-existing-portrait' });
  await click('devices.companionImport.open'); expect(h.created).toHaveBeenCalledWith({ collectionId: 'teammates', kind: 'bot', id: 'bot' });
});
