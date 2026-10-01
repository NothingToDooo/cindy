import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', owner: 'a', pending: false }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  isAppSessionBoundaryPending: () => state.pending,
  ownerScopedUserDataPath: (name: string) => path.join(state.root, state.owner, name),
}));
vi.mock('../built-in-skills.js', () => ({
  builtInSkillPluginRoot: (root: string) => path.join(root, 'builtins'),
  builtInSkillDescriptors: () => [{ name: 'learn' }],
}));
vi.mock('../../cindy-brain/skillSlot.js', () => ({
  ghostSkillPluginRoot: (root: string) => path.join(root, 'agent-skills'),
}));
import { listCindyManagedSkills } from '../managed-skills.js';

async function writeSkill(root: string, slot: string, name: string) {
  const dir = path.join(root, 'skills', slot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Fixture\n---\nBody`,
  );
}

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-managed-skill-catalog-'));
  state.owner = 'a';
  state.pending = false;
});
afterEach(async () => {
  await fs.rm(state.root, { recursive: true, force: true });
});

describe('Cindy managed skill catalog', () => {
  it('lists only official builtins and valid current-owner plugin slots with precise native command names', async () => {
    await writeSkill(path.join(state.root, 'builtins'), 'learn', 'learn');
    await writeSkill(path.join(state.root, 'builtins'), 'unknown', 'unknown');
    const ghostRoot = path.join(state.root, 'a', 'ghost-install-state', 'agent-skills');
    await writeSkill(ghostRoot, 'my-plugin--demo', 'demo');
    await writeSkill(ghostRoot, 'abc', 'unexpected');
    expect((await listCindyManagedSkills()).map((skill) => skill.claudeCommandName)).toEqual([
      'cindy:learn',
      'cindy-plugin-my-plugin:demo',
    ]);
    state.owner = 'b';
    expect((await listCindyManagedSkills()).map((skill) => skill.claudeCommandName)).toEqual([
      'cindy:learn',
    ]);
  });

  it('refuses discovery during an account boundary', async () => {
    state.pending = true;
    await expect(listCindyManagedSkills()).rejects.toThrow('Skill owner is changing');
  });
});
