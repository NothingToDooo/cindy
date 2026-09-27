import { beforeAll, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ start: vi.fn(), handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (event: unknown, input: unknown) => Promise<unknown>) => h.handlers.set(name, fn) } }));
vi.mock('../host.js', () => ({ startCompanionImport: h.start, listCompanionImportSources: vi.fn(), previewCompanionImport: vi.fn(), getCompanionImportResult: vi.fn() }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../device-link/invoke-context.js', () => ({ getDeviceLinkInvokeContext: () => ({ controllerDeviceId: 'phone', channel: 'maker:remote-resources:invoke' }) }));
import { registerCompanionImport } from '../registration.js';
import { registerRemoteResourcesIpc } from '../../device-link/remoteResourcesIpc.js';
import { CompanionImportError } from '../types.js';
beforeAll(() => { registerCompanionImport(); registerRemoteResourcesIpc(); });
const invoke = () => h.handlers.get('maker:remote-resources:invoke')!({}, { collectionId: 'companion-import', resourceRef: { collectionId: 'companion-import', kind: 'import', id: 'preview:source' }, actionId: 'import', input: {}, client: { protocolVersion: 1, primitives: ['companion-import'] } });
it.each(['IMPORT_NAME_EXISTS', 'INVALID_SELECTION', 'PROFILE_TEXT_TOO_LARGE'])('preserves %s through the actual remote provider and IPC boundary', async code => {
  h.start.mockRejectedValueOnce(new CompanionImportError(code));
  await expect(invoke()).rejects.toThrow(`[INVALID_PARAMS] ${code}`);
});
it('continues to hide unexpected provider failures from mobile', async () => {
  h.start.mockRejectedValueOnce(new Error('fixture private filesystem path'));
  await expect(invoke()).rejects.toThrow('[INTERNAL] remote resource provider failed');
});
