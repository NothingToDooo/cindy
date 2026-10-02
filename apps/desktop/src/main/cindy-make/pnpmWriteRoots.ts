import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import yaml from 'js-yaml';

/**
 * Containment for dependency installation of content nobody has verified yet
 * (fork collaborators' synced commits, see `remoteContentScriptsUnverified`).
 *
 * `pnpm install --ignore-scripts --ignore-pnpmfile` keeps content-controlled code
 * from running at install time, but pnpm still writes wherever its write roots
 * point, and content controls those: a tracked `node_modules` symlink makes it
 * install through the link (pnpm creates `<write root>/<dependency name>`, so the
 * link location is the write root), and `.npmrc` / `pnpm-workspace.yaml` settings
 * such as `store-dir`, `modules-dir` or `virtualStoreDir` move the write roots
 * outright. Before such an install every pnpm write root must be a real
 * descendant of the worktree:
 *
 * - no symlink anywhere in the content resolves outside the worktree;
 * - no content-controlled setting may move a write root or pick which code runs
 *   the install (path-shaped config keys and version-management switches are
 *   refused; the store then comes from the machine's own trusted user-level
 *   configuration or pnpm's default);
 * - the prospective write roots themselves (`node_modules` and its virtual store
 *   under every package directory) still resolve inside the worktree when they
 *   already exist as links from a previous run.
 *
 * The check runs on the filesystem, not `git ls-files`: Git's captured output is
 * truncated and quoted paths are escaped, and a reused worktree may hold links
 * that are no longer tracked.
 */

const MAX_SCANNED_ENTRIES = 200_000;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 128;

function refuse(message: string): Error {
  return Object.assign(new Error(message), { code: 'gitFailed' });
}

/** Config keys that move pnpm's writes or select the code that performs them. */
const REFUSED_SETTINGS = new Set([
  'usenodeversion',
  'managepackagemanagerversions',
  'packagemanagerstrict',
  'userconfig',
  'globalconfig',
  'prefix',
  'globalprefix',
  'tmp',
  'temp',
]);

/**
 * Whether a pnpm config key names a location. `store-dir`, `virtual-store-dir`,
 * `modules-dir`, `userConfig` and friends do; `frozen-lockfile`, `node-linker`
 * and `engine-strict` do not and keep working. Single-word location keys are in
 * `REFUSED_SETTINGS` above. Kebab/underscore keys are matched on segment
 * boundaries (`lockfile` is not a `-file` key); camelCase keys on the capital
 * suffix (`storeDir`). pnpm itself only reads the kebab form in `.npmrc` and the
 * camelCase form in `pnpm-workspace.yaml`; the wider net costs a refusal at
 * worst, never an escape.
 */
function refusedSetting(key: string): boolean {
  const name = key.trim();
  if (!name) return false;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (REFUSED_SETTINGS.has(normalized)) return true;
  // `configDependencies` (and any sub-key of it) selects the code that performs
  // the writes: pnpm joins each entry's package name under `node_modules/.pnpm-config`,
  // so a path-like name escapes the worktree no matter where the write roots point.
  // Nothing unverified may configure dependencies at all.
  if (normalized.startsWith('configdependencies')) return true;
  return (
    /(?:^|[-_])(?:dir|path|home|file|config)$/i.test(name) ||
    /[a-z](?:Dir|Path|Home|File|Config)$/.test(name)
  );
}

/** Workspace globs stay relative and inside the tree: `..`, absolute paths and `~` leave it. */
function refusedWorkspacePattern(value: unknown): boolean {
  return (
    typeof value !== 'string' ||
    !value ||
    path.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    value.includes('\\') ||
    value.startsWith('~') ||
    /(^|\/)\.\.($|\/)/.test(value)
  );
}

async function readConfig(file: string): Promise<string> {
  const text = await readFile(file, 'utf8');
  if (text.length > MAX_CONFIG_BYTES) throw refuse(`pnpm config too large: ${path.basename(file)}`);
  return text;
}

/** The recognized pnpm configuration files: never accepted behind a symlink. */
function isPnpmConfigName(name: string): boolean {
  return (
    name === '.npmrc' ||
    name === 'pnpm-workspace.yaml' ||
    name === 'pnpm-workspace.yml' ||
    name === 'package.json' ||
    /pnpmfile\.(?:c|m)?js$/i.test(name)
  );
}

/**
 * The root configuration pnpm reads before anything else, checked without
 * walking the tree: cache warming (`pnpm fetch`) runs this and skips entirely
 * when the content configures its own code (`configDependencies`) or redirects
 * writes. Installs run the full `assertPnpmInstallContained` walk.
 */
export async function assertPnpmConfigContained(root: string): Promise<void> {
  for (const name of ['.npmrc', 'pnpm-workspace.yaml', 'pnpm-workspace.yml', 'package.json']) {
    const full = path.join(root, name);
    let entry;
    try {
      entry = await lstat(full);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) throw refuse(`pnpm config is a symlink: ${name}`);
    if (!entry.isFile()) continue;
    if (name === '.npmrc') checkIni(full, await readConfig(full));
    else if (name === 'package.json') checkPackageJson(full, root, await readConfig(full));
    else checkWorkspaceYaml(full, await readConfig(full));
  }
}

function checkIni(file: string, text: string): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    // npm's INI reads a bare line as a key set to true; treat it the same.
    const separator = line.indexOf('=');
    const key = (separator >= 0 ? line.slice(0, separator) : line).trim();
    if (refusedSetting(key)) throw refuse(`pnpm config redirects writes: ${key}`);
  }
}

function checkSettings(where: string, settings: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(settings)) {
    if (refusedSetting(key)) throw refuse(`pnpm config redirects writes: ${key} in ${where}`);
    if (key === 'packages' || key === 'workspaces') {
      const patterns = Array.isArray(value) ? value : [value];
      for (const pattern of patterns)
        if (refusedWorkspacePattern(pattern))
          throw refuse(`pnpm workspace leaves the worktree: ${String(pattern)}`);
    }
  }
}

/**
 * A path dependency (`link:`, `file:`, a relative or absolute path) makes pnpm
 * symlink or copy whatever it names — including outside the worktree, where a
 * collaborator can point at credentials or user data. Unverified content may
 * depend on registry packages or on paths that stay inside the tree only.
 */
function checkDependencySpecs(
  file: string,
  base: string,
  manifest: Record<string, unknown>,
): void {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const specs = manifest[field];
    if (typeof specs !== 'object' || specs === null || Array.isArray(specs)) continue;
    for (const [name, spec] of Object.entries(specs as Record<string, unknown>)) {
      if (typeof spec !== 'string') continue;
      const value = spec.trim();
      const linked = /^(?:link|file):/i.exec(value);
      const target = linked ? value.slice(linked[0].length) : value;
      const namedPath =
        !!linked ||
        target.startsWith('./') ||
        target.startsWith('../') ||
        path.isAbsolute(target) ||
        /^[a-zA-Z]:/.test(target) ||
        target.startsWith('~');
      if (!namedPath) continue;
      const resolved = path.resolve(path.dirname(file), target);
      const relative = path.relative(base, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw refuse(`pnpm dependency leaves the worktree: ${name}`);
    }
  }
}

function checkWorkspaceYaml(file: string, text: string): void {
  let settings: unknown;
  try {
    settings = yaml.load(text);
  } catch {
    // Content pnpm could not parse either; never install content we cannot check.
    throw refuse(`unparseable ${path.basename(file)}`);
  }
  if (settings === null || settings === undefined) return;
  if (typeof settings !== 'object' || Array.isArray(settings))
    throw refuse(`unrecognized ${path.basename(file)}`);
  checkSettings(path.basename(file), settings as Record<string, unknown>);
}

function checkPackageJson(file: string, base: string, text: string): void {
  let manifest: unknown;
  try {
    // JSON.parse is exactly what pnpm reads, modulo a byte-order mark.
    manifest = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    // A fixture pnpm never reads; it cannot configure anything either.
    return;
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return;
  const record = manifest as Record<string, unknown>;
  const pnpm = record.pnpm;
  if (typeof pnpm === 'object' && pnpm !== null && !Array.isArray(pnpm))
    checkSettings(`${path.basename(file)}#pnpm`, pnpm as Record<string, unknown>);
  checkDependencySpecs(file, base, record);
  if ('workspaces' in record) {
    const value = record.workspaces;
    const patterns =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as { packages?: unknown }).packages ?? []
        : value;
    for (const pattern of Array.isArray(patterns) ? patterns : [patterns])
      if (refusedWorkspacePattern(pattern))
        throw refuse(`npm workspace leaves the worktree: ${String(pattern)}`);
  }
}

async function contained(link: string, resolved: string, root: string, rootReal: string): Promise<void> {
  const within = (target: string, base: string) => {
    const relative = path.relative(base, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const canonical = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  if (!within(canonical(resolved), canonical(root)))
    throw refuse(`symlink leaves the worktree: ${path.relative(root, link)}`);
  // The resolved target may sit under further links; the whole chain must stay in.
  try {
    const chain = await realpath(link);
    if (!within(canonical(chain), canonical(rootReal)))
      throw refuse(`symlink chain leaves the worktree: ${path.relative(root, link)}`);
  } catch (error) {
    // A dangling link is judged by its textual target above (fail closed).
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Every prospective write root under `directory` (its `node_modules` and the
 * virtual store pnpm keeps inside) must be a real descendant of the worktree:
 * within it textually, and with every existing part of the path resolving within
 * it, so a leftover link from a previous run cannot point the writes outside.
 */
async function assertWriteRootDescends(root: string, rootReal: string, directory: string): Promise<void> {
  const within = (target: string, base: string) => {
    const relative = path.relative(base, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const canonical = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  for (const name of [
    'node_modules',
    path.join('node_modules', '.pnpm'),
    // The store `installCindyMakeWorktree` pins for unverified content.
    path.join('node_modules', '.cindy-make-store'),
  ]) {
    const target = path.resolve(directory, name);
    if (!within(canonical(target), canonical(root))) throw refuse('write root outside the worktree');
    for (let probe = target; ; ) {
      try {
        const resolved = await realpath(probe);
        if (!within(canonical(resolved), canonical(rootReal)))
          throw refuse(`write root leaves the worktree: ${path.relative(root, target)}`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if ((error as { code?: string }).code === 'gitFailed') throw error;
          throw refuse('unreadable write root');
        }
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
  }
}

/**
 * Refuse installation of unverified content whose pnpm writes could leave the
 * worktree; see the module comment for what is checked and why. An install of
 * content the user has verified does not run this: its `.npmrc` may configure
 * the machine's own store as the user chose.
 */
export async function assertPnpmInstallContained(root: string): Promise<void> {
  const base = path.resolve(root);
  let rootReal = base;
  try {
    rootReal = await realpath(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing to install into
    throw refuse('unreadable worktree');
  }
  const packageDirectories: string[] = [base];
  let scanned = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw refuse('worktree nests too deeply');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw refuse('unreadable worktree');
    }
    for (const entry of entries) {
      if (++scanned > MAX_SCANNED_ENTRIES) throw refuse('worktree holds too many entries');
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // A recognized config behind a link is never walked past: pnpm follows
        // the link and reads what this scan would have skipped.
        if (isPnpmConfigName(entry.name))
          throw refuse(`pnpm config is a symlink: ${path.relative(base, full)}`);
        await contained(full, path.resolve(directory, await readlink(full)), base, rootReal);
        continue; // never walk through a link
      }
      if (!entry.isFile()) {
        // `.git` bookkeeping and installed dependencies are the harness's and
        // pnpm's own; the `node_modules` entry itself is checked as a link above.
        if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules')
          await walk(full, depth + 1);
        continue;
      }
      if (entry.name === '.npmrc') checkIni(full, await readConfig(full));
      else if (entry.name === 'pnpm-workspace.yaml' || entry.name === 'pnpm-workspace.yml')
        checkWorkspaceYaml(full, await readConfig(full));
      else if (entry.name === 'package.json') {
        packageDirectories.push(directory);
        checkPackageJson(full, base, await readConfig(full));
      }
    }
  };
  await walk(base, 0);
  for (const directory of packageDirectories)
    await assertWriteRootDescends(base, rootReal, directory);
}
