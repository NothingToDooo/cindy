// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionImportApi } from '@cindy/maker-shared/companion-import';
import { BotImportForm } from '../BotImportForm';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('../BotPortraitPicker', () => ({ galleryPortrait: async () => 'data:image/png;base64,original', BotPortraitPicker: ({ onChange, disabled }: { onChange(value: string): void; disabled: boolean }) => <button disabled={disabled} onClick={() => onChange('data:image/png;base64,chosen')}>existing-portrait-picker</button> }));
afterEach(cleanup);

it('uses the original portrait control and sends only the items still selected', async () => {
  const api: CompanionImportApi = { sources: vi.fn<CompanionImportApi['sources']>(async () => [{ id: 'source', name: 'Ada', kind: 'hermes' }]), preview: vi.fn<CompanionImportApi['preview']>(async () => ({ id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [
    { id: 'memory', category: 'memory', name: 'USER.md', selected: true },
    { id: 'skill', category: 'skills', name: 'Useful skill', selected: true },
    { id: 'unused', category: 'skills', name: 'Unused skill', selected: false },
  ] })), status: vi.fn(async () => undefined), start: vi.fn<CompanionImportApi['start']>(async input => ({ requestId: input.requestId, botId: 'imported', canonicalSessionId: 'chat', status: 'complete', checks: [] })) };
  const open = vi.fn();
  render(<BotImportForm api={api} onCreated={open} onBack={() => {}} onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'existing-portrait-picker' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'bots.import.memory' }));
  // The unused skill remains unselected; the selected skill is deliberately kept.
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.submit' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.start).mock.calls[0]![0]).toMatchObject({ name: 'Ada', entryIds: ['skill'], avatarImageBase64: 'chosen' });
  fireEvent.click(await screen.findByRole('button', { name: 'bots.import.open' }));
  expect(open).toHaveBeenCalledWith('imported');
});


it('uses the existing credential checkboxes as alternatives without selecting an arbitrary account in bulk', async () => {
  const api: CompanionImportApi = { sources: async () => [{ id: 'source', name: 'Ada', kind: 'hermes' }], preview: async () => ({ id: 'preview', name: 'Ada', source: { id: 'source', name: 'Ada', kind: 'hermes' }, entries: [
    { id: 'work', category: 'connections', name: 'Work', selected: false, exclusiveWith: ['personal'] },
    { id: 'personal', category: 'connections', name: 'Personal', selected: false, exclusiveWith: ['work'] },
  ] }), status: async () => undefined, start: vi.fn<CompanionImportApi['start']>(async input => ({ requestId: input.requestId, botId: 'bot', status: 'complete', checks: [] })) };
  render(<BotImportForm api={api} onCreated={() => {}} onBack={() => {}} onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ada.*Hermes/ }));
  await screen.findByRole('button', { name: 'existing-portrait-picker' });
  fireEvent.click(screen.getByText('bots.import.connections', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'bots.import.connections' }));
  expect((screen.getByLabelText('Work') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText('Work'));
  fireEvent.click(screen.getByLabelText('Personal'));
  expect((screen.getByLabelText('Work') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('Personal') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'bots.import.submit' }));
  await waitFor(() => expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ entryIds: ['personal'] })));
});
