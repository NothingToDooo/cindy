import { isSkillhubPublishErrorCode, serverPublishErrorCode, type SkillhubPublishErrorCode } from '../../../../shared/skillhubPublishErrors';

interface ScanGateLike {
  name: string;
}

function normalizeCode(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function isPublicationProcessingFailure(gates: ScanGateLike[] | undefined): boolean {
  return publicationProcessingErrorCode(gates) !== undefined;
}

/** Error-code gates come from upload processing, rather than a security scan. */
export function publicationProcessingErrorCode(gates: ScanGateLike[] | undefined): SkillhubPublishErrorCode | undefined {
  for (const gate of gates ?? []) {
    const code = normalizeCode(gate.name).replaceAll('-', '_').toUpperCase();
    if (isSkillhubPublishErrorCode(code)) return code;
    if (['INTERNAL_ERROR', 'FORBIDDEN', 'UPLOAD_SESSION_EXPIRED', 'STORAGE_UNAVAILABLE'].includes(code)) {
      return serverPublishErrorCode(code);
    }
  }
  return undefined;
}
