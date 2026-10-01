import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_LEGACY_CODEX_SKILLS_LINK_NAME,
  CODEX_SHARED_AGENTS_SKILLS_LINK_NAME,
  codexGlobalSkillsPaths,
  codexManagedSkillLinkName,
  prepareCodexGlobalSkillsLinks,
} from '../maker-host/codex-global-skills';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-global-skills-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeSkill(skillsDir: string, name: string): Promise<void> {
  const skillDir = path.join(skillsDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\n\nbody\n`,
    'utf8',
  );
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(ra) === normalize(rb);
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareCodexGlobalSkillsLinks', () => {
  it('loads only verified individual sources, retires old aggregates and preserves foreign occupants', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'codex');
    const ownerA = path.join(
      root,
      'owner-a',
      'ghost-install-state',
      'skill-snapshots',
      'example',
      'rev',
    );
    const ownerB = path.join(
      root,
      'owner-b',
      'ghost-install-state',
      'skill-snapshots',
      'example',
      'rev',
    );
    await writeSkill(path.join(ownerA, 'skills'), 'learn');
    await writeSkill(path.join(ownerB, 'skills'), 'learn');
    const projection = path.join(root, 'owner-a', 'ghost-install-state', 'agent-skills', 'skills');
    await writeSkill(projection, 'unapproved--extra');
    await fs.mkdir(path.join(codexHome, 'skills'), { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(projection, path.join(codexHome, 'skills', 'cindy-1'), linkType);
    const foreign = path.join(root, 'foreign');
    await fs.mkdir(foreign);
    await fs.symlink(foreign, path.join(codexHome, 'skills', 'cindy-foreign'), linkType);
    await fs.mkdir(path.join(codexHome, 'skills', 'cindy-user-directory'));
    const command = 'cindy-plugin-example:learn';
    const link = path.join(codexHome, 'skills', codexManagedSkillLinkName(command));
    const options = (owner: string) => ({
      homeDir,
      managedRoots: [root],
      managedSkills: [
        {
          path: path.join(owner, 'skills', 'learn', 'SKILL.md'),
          claudeCommandName: command,
        },
      ],
    });
    await prepareCodexGlobalSkillsLinks(codexHome, options(ownerA));
    expect(await sameRealPath(link, path.join(ownerA, 'skills', 'learn'))).toBe(true);
    await expect(fs.lstat(path.join(codexHome, 'skills', 'cindy-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readdir(projection)).toEqual(['unapproved--extra']);
    await prepareCodexGlobalSkillsLinks(codexHome, options(ownerB));
    expect(await sameRealPath(link, path.join(ownerB, 'skills', 'learn'))).toBe(true);
    await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      managedRoots: [root],
      managedSkills: [],
    });
    await expect(fs.lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sameRealPath(path.join(codexHome, 'skills', 'cindy-foreign'), foreign)).toBe(true);
    expect(
      (await fs.stat(path.join(codexHome, 'skills', 'cindy-user-directory'))).isDirectory(),
    ).toBe(true);
    await fs.symlink(foreign, link, linkType);
    const conflict = await prepareCodexGlobalSkillsLinks(codexHome, options(ownerA));
    expect(conflict.sources.find((source) => source.link === link)?.status).toBe('conflict');
    expect(await sameRealPath(link, foreign)).toBe(true);
    await expect(fs.stat(path.join(homeDir, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(homeDir, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('links legacy Codex and shared agent skills directly under the custom CODEX_HOME skills root', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');
    await writeSkill(agentsSkills, 'shared-skill');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(path.basename(paths.legacyCodexSkillsLink)).toBe(CODEX_LEGACY_CODEX_SKILLS_LINK_NAME);
    expect(path.basename(paths.sharedAgentsSkillsLink)).toBe(CODEX_SHARED_AGENTS_SKILLS_LINK_NAME);
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
    expect(await sameRealPath(paths.sharedAgentsSkillsLink, agentsSkills)).toBe(true);
  });

  it('skips missing source roots without failing the scan-entry setup', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
    expect(result.sources.find((source) => source.name === 'codex')?.status).toMatch(/linked|kept/);
    expect(result.sources.find((source) => source.name === 'agents')?.status).toBe('missing');
  });

  it('removes a stale managed link when its source root disappears', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);

    await fs.rm(legacySkills, { recursive: true, force: true });
    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(result.sources.find((source) => source.name === 'codex')?.status).toBe('missing');
    await expect(fs.lstat(paths.legacyCodexSkillsLink)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not replace a non-managed directory at a source link path', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const conflictingDir = paths.legacyCodexSkillsLink;
    await fs.mkdir(conflictingDir, { recursive: true });
    await fs.writeFile(path.join(conflictingDir, 'keep.txt'), 'do not remove', 'utf8');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(result.sources.find((source) => source.name === 'codex')?.status).toBe('conflict');
    await expect(fs.readFile(path.join(conflictingDir, 'keep.txt'), 'utf8')).resolves.toBe(
      'do not remove',
    );
    expect(
      result.warnings.some((warning) => warning.includes('cannot link Codex codex skills')),
    ).toBe(true);
  });

  it('removes the old aggregate scan link without deleting non-managed files', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const oldAggregateDir = path.join(codexHome, 'global_skills');
    const oldScanEntry = path.join(codexHome, 'skills', 'xdt-global');
    await fs.mkdir(path.join(codexHome, 'skills'), { recursive: true });
    await fs.mkdir(oldAggregateDir, { recursive: true });
    await fs.symlink(
      oldAggregateDir,
      oldScanEntry,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.writeFile(path.join(oldAggregateDir, 'keep.txt'), 'do not remove', 'utf8');

    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    await expect(fs.lstat(oldScanEntry)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(oldAggregateDir, 'keep.txt'), 'utf8')).resolves.toBe(
      'do not remove',
    );
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
  });
});
