import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '',
  owner: 'a',
  pending: false,
  enabled: true,
  verified: true,
}));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../built-in-skills.js', () => ({
  sharedBuiltInSkillsRoot: (root: string) => path.join(root, 'shared-system-skills'),
  builtInSkillDescriptors: () => [
    { name: 'learn', absolutePath: path.join(state.root, 'official', 'skills', 'learn') },
  ],
}));
vi.mock('../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ verifyApprovedSkillSnapshot: async () => state.verified }),
  listAvailableGhostsForAuthorization: () => [
    {
      enabled: state.enabled,
      approvedSkillRoot: path.join(state.root, state.owner, 'approved'),
      manifest: {
        id: 'my-plugin',
        skill: {
          items: [{ name: 'demo', dir: 'skills/demo', description: 'Approved description' }],
        },
      },
    },
  ],
}));
import { listCindyManagedSkills } from '../managed-skills.js';

async function writeSkill(root: string, slot: string, name: string) {
  const dir = path.join(root, 'skills', slot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: "${name}"\ndescription: Fixture\n---\nBody`,
  );
}

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-managed-skill-catalog-'));
  state.owner = 'a';
  state.pending = false;
  state.enabled = true;
  state.verified = true;
  await writeSkill(path.join(state.root, 'official'), 'learn', 'learn');
  await writeSkill(path.join(state.root, 'a', 'approved'), 'demo', ' demo ');
});
afterEach(async () => {
  await fs.rm(state.root, { recursive: true, force: true });
});

describe('Cindy managed skill catalog', () => {
  it('uses verified sources and manifest names despite real-directory and foreign-link projection conflicts', async () => {
    await writeSkill(path.join(state.root, 'managed-agent-skills', 'cindy'), 'learn', 'impostor');
    const ghostRoot = path.join(state.root, 'a', 'ghost-install-state', 'agent-skills');
    await writeSkill(ghostRoot, 'my-plugin--demo', 'unapproved');
    await fs.symlink(
      path.join(ghostRoot, 'skills', 'my-plugin--demo'),
      path.join(ghostRoot, 'skills', 'foreign--demo'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const skills = await listCindyManagedSkills();
    expect(skills.map((skill) => skill.claudeCommandName)).toEqual([
      'cindy:learn',
      'cindy-plugin-my-plugin:demo',
    ]);
    expect(skills.map((skill) => skill.path)).toEqual(
      await Promise.all([
        fs.realpath(path.join(state.root, 'official', 'skills', 'learn', 'SKILL.md')),
        fs.realpath(path.join(state.root, 'a', 'approved', 'skills', 'demo', 'SKILL.md')),
      ]),
    );
    expect(skills[1]?.description).toBe('Approved description');
    state.owner = 'b';
    expect((await listCindyManagedSkills()).map((skill) => skill.claudeCommandName)).toEqual([
      'cindy:learn',
    ]);
  });

  it.each(['disabled', 'unverified'])(
    'does not discover a %s plugin from an occupied slot',
    async (mode) => {
      await writeSkill(
        path.join(state.root, 'a', 'ghost-install-state', 'agent-skills'),
        'my-plugin--demo',
        'demo',
      );
      if (mode === 'disabled') state.enabled = false;
      else state.verified = false;
      expect((await listCindyManagedSkills()).map((skill) => skill.claudeCommandName)).toEqual([
        'cindy:learn',
      ]);
    },
  );

  it('refuses discovery during an account boundary', async () => {
    state.pending = true;
    await expect(listCindyManagedSkills()).rejects.toThrow('Skill owner is changing');
  });
});
