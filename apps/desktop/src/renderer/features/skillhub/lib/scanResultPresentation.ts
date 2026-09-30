import { isSkillhubPublishErrorCode, serverPublishErrorCode, type SkillhubPublishErrorCode } from '../../../../shared/skillhubPublishErrors';
import { isPassingScanStatus } from './scanStatus';

interface ScanGateLike {
  name: string;
  status?: string;
  issues?: unknown[];
}

function normalizeCode(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function isPublicationProcessingFailure(gates: ScanGateLike[] | undefined): boolean {
  return publicationProcessingErrorCode(gates) !== undefined;
}

export function scanPublicationErrorCode(value: unknown, message?: unknown): SkillhubPublishErrorCode | undefined {
  const code = normalizeCode(value).replaceAll('-', '_').toUpperCase();
  if (isSkillhubPublishErrorCode(code)) return code;
  if (['INTERNAL_ERROR', 'FORBIDDEN', 'UPLOAD_SESSION_EXPIRED', 'STORAGE_UNAVAILABLE'].includes(code)) {
    return serverPublishErrorCode(code, typeof message === 'string' ? message : '');
  }
  return undefined;
}

/** Processing failures can use an issue code or a legacy error-code gate name. */
export function publicationProcessingErrorCode(gates: ScanGateLike[] | undefined): SkillhubPublishErrorCode | undefined {
  for (const gate of gates ?? []) {
    if (gate.status != null && isPassingScanStatus(gate.status)) continue;
    for (const value of gate.issues ?? []) {
      if (!value || typeof value !== 'object') continue;
      const issue = value as Record<string, unknown>;
      if (issue.severity != null && issue.severity !== 'error') continue;
      const code = scanPublicationErrorCode(issue.code, issue.message);
      if (code) return code;
    }
    const code = scanPublicationErrorCode(gate.name);
    if (code) return code;
  }
  return undefined;
}
