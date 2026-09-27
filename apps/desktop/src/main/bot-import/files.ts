import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { CompanionImportError, type ImportFile } from './types.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ITEM_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 4096;

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Refuse symlink escapes and special files before reading any bytes. */
export async function readImportFile(root: string, file: string): Promise<ImportFile> {
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(file);
  if (!inside(realRoot, realFile)) throw new CompanionImportError('SOURCE_LINK_OUTSIDE_FOLDER');
  const handle = await fs.open(realFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CompanionImportError('SOURCE_NOT_REGULAR_FILE');
    if (stat.size > MAX_FILE_BYTES) throw new CompanionImportError('SOURCE_FILE_TOO_LARGE');
    // A bounded read also handles files growing after fstat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > stat.size) throw new CompanionImportError('SOURCE_CHANGED');
    return { name: path.relative(root, file).split(path.sep).join('/'), bytes: bytes.subarray(0, size), executable: (stat.mode & 0o111) !== 0 };
  } finally { await handle.close(); }
}

export async function optionalText(root: string, file: string): Promise<string | undefined> {
  try { return (await readImportFile(root, file)).bytes.toString('utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Only traverses the selected skill/document subtree; never copies a whole Agent home. */
export async function readImportTree(root: string, include: (name: string) => boolean = () => true): Promise<ImportFile[]> {
  const result: ImportFile[] = [];
  const visited = new Set<string>();
  let size = 0;
  const realRoot = await fs.realpath(root);
  async function visit(dir: string) {
    const real = await fs.realpath(dir);
    if (!inside(realRoot, real)) throw new CompanionImportError('SOURCE_LINK_OUTSIDE_FOLDER');
    if (visited.has(real)) throw new CompanionImportError('SOURCE_LINK_CYCLE');
    visited.add(real);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
      const file = path.join(dir, entry.name);
      const target = entry.isSymbolicLink() ? await fs.stat(file) : entry;
      if (target.isDirectory()) await visit(file);
      else if (include(path.relative(root, file))) {
        const item = await readImportFile(root, file);
        size += item.bytes.length;
        if (size > MAX_ITEM_BYTES || result.length >= MAX_FILES) throw new CompanionImportError('SOURCE_ITEM_TOO_LARGE');
        result.push(item);
      }
    }
    visited.delete(real);
  }
  await visit(root);
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeImportFiles(root: string, files: readonly ImportFile[]): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = path.resolve(root, file.name);
    if (!inside(root, target) || target === root) throw new CompanionImportError('INVALID_TARGET');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // Imports write into newly allocated directories; never follow a pre-existing entry.
    const handle = await fs.open(target, 'wx', file.executable ? 0o700 : 0o600);
    try { await handle.writeFile(file.bytes); } finally { await handle.close(); }
  }
}
