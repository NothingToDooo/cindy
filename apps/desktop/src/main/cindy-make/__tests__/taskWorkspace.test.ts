import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCindyMakeWorktree,
  installCindyMakeWorktree,
  isCindyMakeWorktreePath,
  prepareCindyMakeWorkspace,
} from '../taskWorkspace';

vi.mock('../sourceContent', () => ({
  contentRef: vi.fn(async () => undefined),
  snapshotContent: vi.fn(async () => 'f'.repeat(40)),
  applyContent: vi.fn(async () => {}),
  taskContentRef: (run: string) => 'refs/cindy-make/tasks/' + run + '/base',
}));

describe('prepareCindyMakeWorkspace', () => {
  let userData: string;
  beforeEach(async () => {
    userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-workspace-'));
    await mkdir(path.join(userData, 'cindy-make', 'source', '.git'), { recursive: true });
  });
  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  it('branches a new worktree off the personal baseline and installs dependencies', async () => {
    const git = vi.fn(async (_env: NodeJS.ProcessEnv, args: string[]) => {
      if (args[0] === 'branch' && args[1] === '--show-current') return 'cindy-personal';
      if (args[0] === 'branch' && args[2] === 'cindy-personal') return '  cindy-personal\n';
      if (args[0] === 'branch') return '';
      if (args[0] === 'rev-parse') return 'abcdef1234567\n';
      if (args[0] === 'worktree' || args[0] === 'update-ref') return '';
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const pnpm = vi.fn(async () => undefined);
    const phases: string[] = [];
    const workspace = await prepareCindyMakeWorkspace(
      userData,
      'run-1',
      new AbortController().signal,
      { processEnvironment: { PATH: '' }, git, pnpm },
      (phase) => phases.push(phase),
    );
    const worktreePath = path.join(userData, 'cindy-make', 'worktrees', 'run-1');
    expect(workspace).toEqual({
      path: worktreePath,
      branch: 'cindy-make/run-1',
      baseCommit: 'abcdef1234567',
    });
    expect(git).toHaveBeenCalledWith(
      expect.anything(),
      ['worktree', 'add', '-b', 'cindy-make/run-1', worktreePath, 'cindy-personal'],
      path.join(userData, 'cindy-make', 'source'),
      expect.anything(),
    );
    expect(pnpm).toHaveBeenCalledWith(
      expect.anything(),
      ['install', '--frozen-lockfile', '--prefer-offline', '--prod=false'],
      worktreePath,
      expect.anything(),
    );
    expect(phases).toEqual(['checking', 'creating', 'installing']);
  });

  /** Windows without Developer Mode cannot create symlinks; Git stores plain files there. */
  const linkIfPossible = async (target: string, link: string): Promise<boolean> => {
    try {
      await symlink(target, link, 'dir');
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') return false;
      throw error;
    }
  };

  const withManifest = async (runId: string): Promise<string> => {
    const worktreePath = path.join(userData, 'cindy-make', 'worktrees', runId);
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, 'package.json'), '{"name":"app","version":"1.0.0"}');
    return worktreePath;
  };

  const installUnverified = (
    runId: string,
    worktreePath: string,
    deps: Parameters<typeof installCindyMakeWorktree>[3],
  ) =>
    installCindyMakeWorktree(
      userData,
      { path: worktreePath, branch: `cindy-make/${runId}`, baseCommit: 'b'.repeat(40) },
      new AbortController().signal,
      deps,
      undefined,
      undefined,
      { ignoreScripts: true },
    );

  it('runs no lifecycle scripts and no pnpm hooks for unverified synced content', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-9');
    await writeFile(
      path.join(worktreePath, '.npmrc'),
      'node-linker=hoisted\nfrozen-lockfile=true\nengine-strict=true\n',
    );
    await writeFile(
      path.join(worktreePath, 'pnpm-workspace.yaml'),
      'packages:\n  - "apps/*"\n  - "packages/*"\n',
    );
    await installUnverified('run-9', worktreePath, {
      processEnvironment: { PATH: '', npm_config_registry: 'http://attacker.invalid' },
      pnpm,
    });
    expect(pnpm).toHaveBeenCalledWith(
      // No `npm_config_*` setting of the content's own can turn the guards back on;
      // pnpm's write roots stay inside the worktree whatever `.npmrc` says; and the
      // user's npm credentials are never loaded for this install.
      { PATH: '', npm_config_userconfig: os.devNull },
      [
        'install',
        '--frozen-lockfile',
        '--prefer-offline',
        '--prod=false',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--config.modules-dir=node_modules',
        '--config.virtual-store-dir=node_modules/.pnpm',
        '--config.store-dir=node_modules/.cindy-make-store',
        '--config.strict-ssl=true',
      ],
      worktreePath,
      expect.anything(),
    );
  });

  it('keeps inherited secrets out of an unverified install environment', async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const pnpm = vi.fn(async (env: NodeJS.ProcessEnv) => {
      seen = env;
    });
    const worktreePath = await withManifest('run-12');
    await installUnverified('run-12', worktreePath, {
      processEnvironment: {
        PATH: '/tools',
        SystemRoot: 'C:\\Windows',
        HOME: '/home/me',
        npm_config_python: '/tools/python',
        npm_config_manage_package_manager_versions: 'false',
        // How Cindy was launched must not reach a content `.npmrc`: its `${VAR}`
        // expansion would send these to a registry the content chooses.
        NPM_TOKEN: 'gho_secret-token',
        GITHUB_TOKEN: 'ghp_secret-token',
        AWS_SECRET_ACCESS_KEY: 'aws_secret-key',
        HTTP_PROXY: 'http://user:pass@proxy.invalid',
      },
      pnpm,
    });
    expect(seen).toEqual({
      PATH: '/tools',
      SystemRoot: 'C:\\Windows',
      HOME: '/home/me',
      npm_config_python: '/tools/python',
      npm_config_manage_package_manager_versions: 'false',
      npm_config_userconfig: os.devNull,
    });
  });

  it('refuses to install unverified content through a node_modules link', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-10');
    // The link is the write root: pnpm would create `<link>/<dependency name>`
    // wherever it points.
    if (!(await linkIfPossible(os.tmpdir(), path.join(worktreePath, 'node_modules')))) return;
    await expect(
      installUnverified('run-10', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content whose links leave the worktree under any name', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-11');
    if (!(await linkIfPossible(os.tmpdir(), path.join(worktreePath, '.m')))) return;
    await expect(
      installUnverified('run-11', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content that redirects the pnpm store from .npmrc', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-12');
    await writeFile(path.join(worktreePath, '.npmrc'), 'store-dir=/attacker/store\n');
    await expect(
      installUnverified('run-12', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified content that moves pnpm write roots from workspace settings', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-13');
    await writeFile(
      path.join(worktreePath, 'pnpm-workspace.yaml'),
      'packages:\n  - "apps/*"\nvirtualStoreDir: .elsewhere\n',
    );
    await expect(
      installUnverified('run-13', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses unverified workspace globs and manifest settings that leave the worktree', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-14');
    await writeFile(
      path.join(worktreePath, 'pnpm-workspace.yaml'),
      'packages:\n  - "../*"\n',
    );
    await expect(
      installUnverified('run-14', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    await writeFile(path.join(worktreePath, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    await writeFile(
      path.join(worktreePath, 'package.json'),
      '{"name":"app","version":"1.0.0","pnpm":{"storeDir":"/attacker/store"}}',
    );
    await expect(
      installUnverified('run-14', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('refuses when an existing write root resolves outside the worktree', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-15');
    await mkdir(path.join(worktreePath, 'node_modules'), { recursive: true });
    if (!(await linkIfPossible(os.tmpdir(), path.join(worktreePath, 'node_modules', '.pnpm'))))
      return;
    await expect(
      installUnverified('run-15', worktreePath, { processEnvironment: { PATH: '' }, pnpm }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
    expect(pnpm).not.toHaveBeenCalled();
  });

  it('lets verified content configure the machine\'s own pnpm store', async () => {
    const pnpm = vi.fn(async () => undefined);
    const worktreePath = await withManifest('run-16');
    await writeFile(
      path.join(worktreePath, '.npmrc'),
      `store-dir=${path.join(os.tmpdir(), 'own-store')}\n`,
    );
    await installCindyMakeWorktree(
      userData,
      { path: worktreePath, branch: 'cindy-make/run-16', baseCommit: 'b'.repeat(40) },
      new AbortController().signal,
      { processEnvironment: { PATH: '' }, pnpm },
    );
    expect(pnpm).toHaveBeenCalledOnce();
  });

  it('reuses an existing worktree on the task branch and refuses a foreign directory', async () => {
    const worktreePath = path.join(userData, 'cindy-make', 'worktrees', 'run-2');
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, '.git'), 'gitdir: ../../source/.git/worktrees/run-2\n');
    const git = vi.fn(async (_env: NodeJS.ProcessEnv, args: string[], cwd: string) => {
      if (args[0] === 'branch')
        return args[2] === 'cindy-personal' ? 'cindy-personal' : 'cindy-make/run-2';
      if (args.includes('--git-common-dir')) return path.join(userData, 'cindy-make/source/.git');
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        expect(cwd).toBe(worktreePath);
        return 'cindy-make/run-2';
      }
      if (args[0] === 'rev-parse') return 'abcdef1234567';
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const pnpm = vi.fn(async () => undefined);
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-2', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm,
      }),
    ).resolves.toMatchObject({ path: worktreePath, branch: 'cindy-make/run-2' });
    expect(git.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);

    await rm(path.join(worktreePath, '.git'));
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-2', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm,
      }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
  });

  it('fails before touching Git when the source or personal branch is missing', async () => {
    const git = vi.fn<(env: NodeJS.ProcessEnv, args: string[]) => Promise<string>>(async () => '');
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-3', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'environmentNotReady' });
    expect(git.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);

    await rm(path.join(userData, 'cindy-make', 'source', '.git'), { recursive: true });
    await expect(
      prepareCindyMakeWorkspace(userData, 'run-3', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'environmentNotReady' });
    await expect(
      prepareCindyMakeWorkspace(userData, '../escape', new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'gitFailed' });
  });
});

describe('split Cindy Make workspace preparation', () => {
  it('creates the worktree without pnpm, then installs in a separate step', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-split-'));
    try {
      await mkdir(path.join(userData, 'cindy-make', 'source', '.git'), { recursive: true });
      const git = vi.fn(async (_env: NodeJS.ProcessEnv, args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'cindy-personal';
        if (args[0] === 'branch' && args[2] === 'cindy-personal') return 'cindy-personal\n';
        if (args[0] === 'rev-parse') return 'base123\n';
        if (args[0] === 'worktree' || args[0] === 'update-ref') return '';
        return '';
      });
      const pnpm = vi.fn(async () => undefined);
      const workspace = await createCindyMakeWorktree(
        userData,
        'run-split',
        new AbortController().signal,
        { processEnvironment: {}, git, pnpm },
      );
      expect(pnpm).not.toHaveBeenCalled();
      await installCindyMakeWorktree(userData, workspace, new AbortController().signal, {
        processEnvironment: {},
        git,
        pnpm,
      });
      expect(pnpm).toHaveBeenCalledOnce();
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });
});

describe('isCindyMakeWorktreePath', () => {
  const userData = path.resolve(os.tmpdir(), 'cindy-userdata');
  const worktrees = path.join(userData, 'cindy-make', 'worktrees');
  it('accepts only a direct child of the worktrees root named like a run id', () => {
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, 'run-1'))).toBe(true);
    expect(isCindyMakeWorktreePath(userData, worktrees)).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, 'run-1', 'apps'))).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(worktrees, '..', 'source'))).toBe(false);
    expect(isCindyMakeWorktreePath(userData, path.join(userData, 'cindy-make', 'source'))).toBe(
      false,
    );
  });
});
