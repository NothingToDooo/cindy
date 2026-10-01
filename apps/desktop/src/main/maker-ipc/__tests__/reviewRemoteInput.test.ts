import { describe, expect, it, vi } from 'vitest';
import { buildPeerAttachmentRef } from '@cindy/device-link';
import { prepareRemoteReviewAttachments } from '../reviewRemoteInput';

describe('remote Review attachment preparation', () => {
  const ref = buildPeerAttachmentRef({ ticket: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', size: 10, sha256: 'a'.repeat(64), mimeType: 'text/plain' });
  const request = { sourceSessionId: 'source', attachments: [{ name: 'notes.md', url: ref, path: ref }] };

  it('materializes into the Reviewer owner before snapshotting and releases both copies on cleanup', async () => {
    const cleanupAfterAcceptance = vi.fn();
    const cleanupLocalMaterialization = vi.fn().mockResolvedValue(undefined);
    const files = [{ name: 'notes.md', url: 'xdt-image://reviewer/notes.md' }];
    const materialize = vi.fn().mockResolvedValue({ item: { files }, cleanupAfterAcceptance, cleanupLocalMaterialization });
    const prepared = await prepareRemoteReviewAttachments(request, 'reviewer', materialize);
    expect(materialize).toHaveBeenCalledWith('reviewer', { files: request.attachments });
    expect(prepared.attachments).toEqual(files);
    expect(cleanupLocalMaterialization).not.toHaveBeenCalled();
    await prepared.cleanup();
    expect(cleanupAfterAcceptance).toHaveBeenCalledOnce();
    expect(cleanupLocalMaterialization).toHaveBeenCalledOnce();
  });

  it.each(['/controller/notes.md', 'cindy-media://blobs/local.png', 'https://example.com/file'])('does not interpret controller input %s as a host file', async (url) => {
    const materialize = vi.fn();
    await expect(prepareRemoteReviewAttachments({ ...request, attachments: [{ name: 'notes.md', url }] }, 'reviewer', materialize)).rejects.toThrow('INVALID_PARAMS');
    expect(materialize).not.toHaveBeenCalled();
  });

  it('fails and releases local materializations if the transfer leaves unresolved references', async () => {
    const cleanupLocalMaterialization = vi.fn().mockResolvedValue(undefined);
    const materialize = vi.fn().mockResolvedValue({ item: { files: request.attachments }, cleanupLocalMaterialization });
    await expect(prepareRemoteReviewAttachments(request, 'reviewer', materialize)).rejects.toThrow('DEVICE_LINK_MEDIA_TRANSFER_FAILED');
    expect(cleanupLocalMaterialization).toHaveBeenCalledOnce();
  });
});
