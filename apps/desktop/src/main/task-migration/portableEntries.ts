import path from 'node:path';
import type { FileEvidence } from '../worktree/recoveryArchiveIO';

/** Why one project entry was left out of a task copy. */
export type SkipCode =
  | 'MIGRATION_NONPORTABLE_PATH'
  | 'MIGRATION_PATH_COLLISION'
  | 'MIGRATION_EXTERNAL_LINK'
  | 'MIGRATION_UNSUPPORTED_ENTRY';
/** `path` is project-relative and `/`-separated; a skipped directory stands for its whole subtree. */
export interface SkippedEntry {
  path: string;
  code: SkipCode;
}

// Same bound as POSIX SYMLOOP_MAX on common systems.
const MAX_LINK_HOPS = 40;

function nonportable(name: string): boolean {
  const parts = name.split('/');
  return (
    !name ||
    name.length > 4096 ||
    name.includes('\\') ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.toLowerCase() === '.git' ||
        /[\x00-\x1f:*?"<>|]/.test(part) ||
        /[ .]$/.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  );
}

function unsafeLinkText(target: string): boolean {
  return (
    !target || target.includes('\\') || path.posix.isAbsolute(target) || /^[a-z]:/i.test(target)
  );
}

/**
 * Resolve `link` the way the filesystem would, following links through the manifest.
 * Inside means every step stays under the root and never touches `.git`; a missing
 * component is fine (a dangling link cannot reach anything), so it continues lexically.
 */
function linkStaysInside(files: Record<string, FileEvidence>, link: string): boolean {
  const resolved = link.split('/').slice(0, -1);
  let pending = files[link].hash.split('/');
  let hops = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) return false;
      resolved.pop();
      continue;
    }
    if (part.toLowerCase() === '.git') return false;
    resolved.push(part);
    const entry = files[resolved.join('/')];
    if (entry?.kind !== 'link') continue;
    if (++hops > MAX_LINK_HOPS || unsafeLinkText(entry.hash)) return false;
    resolved.pop();
    pending = [...entry.hash.split('/'), ...pending];
  }
  return true;
}

function assertEvidence(entry: FileEvidence | undefined): void {
  if (
    !entry ||
    !['file', 'directory', 'link'].includes(entry.kind) ||
    !Number.isInteger(entry.mode) ||
    entry.mode < 0 ||
    entry.mode > 0o777 ||
    typeof entry.hash !== 'string' ||
    (entry.kind === 'file' && !/^[a-f0-9]{64}$/.test(entry.hash)) ||
    (entry.kind === 'directory' && entry.hash !== '')
  )
    throw new Error('MIGRATION_INVALID_MANIFEST');
}

/**
 * Split a workspace inventory into what a copy can carry and what it leaves behind.
 * Keys may use the platform separator; kept keys are returned unchanged. Only links whose
 * resolution leaves the root are refused — chains and dangling links inside it are copied
 * as they are. A malformed manifest still throws: that is corruption, not a project entry.
 */
export function selectPortableEntries(
  files: Record<string, FileEvidence>,
  unsupported: readonly string[] = [],
  separator = path.sep,
): { files: Record<string, FileEvidence>; skipped: SkippedEntry[] } {
  const posix = (name: string) => (separator === '/' ? name : name.split(separator).join('/'));
  const byPosix: Record<string, FileEvidence> = Object.create(null);
  for (const [name, entry] of Object.entries(files)) {
    assertEvidence(entry);
    byPosix[posix(name)] = entry;
  }
  const skipped: SkippedEntry[] = unsupported.map((name) => ({
    path: posix(name),
    code: 'MIGRATION_UNSUPPORTED_ENTRY',
  }));
  const reason = new Map<string, SkipCode>();
  const folded = new Set<string>();
  for (const name of Object.keys(byPosix)) {
    if (nonportable(name)) {
      reason.set(name, 'MIGRATION_NONPORTABLE_PATH');
      continue;
    }
    const key = name.normalize('NFC').toLowerCase();
    if (folded.has(key)) reason.set(name, 'MIGRATION_PATH_COLLISION');
    else folded.add(key);
  }
  // Resolve links against what the target will hold; a link into a skipped entry just dangles.
  const named: Record<string, FileEvidence> = Object.create(null);
  for (const [name, entry] of Object.entries(byPosix)) if (!reason.has(name)) named[name] = entry;
  for (const [name, entry] of Object.entries(named)) {
    if (entry.kind === 'link' && (unsafeLinkText(entry.hash) || !linkStaysInside(named, name)))
      reason.set(name, 'MIGRATION_EXTERNAL_LINK');
  }
  const kept: Record<string, FileEvidence> = Object.create(null);
  for (const [name, entry] of Object.entries(files)) {
    const relative = posix(name);
    const parts = relative.split('/');
    const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    // A skipped directory takes its subtree with it; report only the directory.
    if (ancestors.some((ancestor) => reason.has(ancestor))) continue;
    const code = reason.get(relative);
    if (code) {
      skipped.push({ path: relative, code });
      continue;
    }
    if (ancestors.some((ancestor) => byPosix[ancestor]?.kind !== 'directory'))
      throw new Error('MIGRATION_INVALID_MANIFEST');
    kept[name] = entry;
  }
  return { files: kept, skipped };
}
