import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import matter from 'gray-matter';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { GHOST_SKILL_NAME_RE, isValidGhostId } from '../../shared/ghost.js';
import type { AgentDeps } from '@cindy/maker-core';
import { builtInSkillDescriptors, builtInSkillPluginRoot } from './built-in-skills.js';
import { ghostSkillPluginRoot } from '../cindy-brain/skillSlot.js';

/** Resolve the active owner at consumption time; never cache another owner's root. */
export async function cindyManagedSkillRoots(): Promise<string[]> {
  return [
    builtInSkillPluginRoot(app.getPath('userData')),
    ghostSkillPluginRoot(ownerScopedUserDataPath('ghost-install-state')),
  ];
}

export const listCindyManagedSkills: NonNullable<AgentDeps['getManagedSkills']> = async () => {
  const owner = activeOwnerScopeKey();
  if (isAppSessionBoundaryPending()) throw new Error('Skill owner is changing');
  const roots = await cindyManagedSkillRoots();
  const builtIns = builtInSkillDescriptors(app.getPath('userData'), app.getPath('appData'));
  const skills: Awaited<ReturnType<NonNullable<AgentDeps['getManagedSkills']>>> = [];
  for (const [index, root] of roots.entries()) {
    const entries = await fs
      .readdir(path.join(root, 'skills'))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    for (const entry of entries.sort()) {
      if (index === 0 && !builtIns.some((skill) => skill.name === entry)) continue;
      const splitAt = entry.lastIndexOf('--');
      const id = entry.slice(0, splitAt);
      if (
        index !== 0 &&
        (splitAt <= 0 || !isValidGhostId(id) || !GHOST_SKILL_NAME_RE.test(entry.slice(splitAt + 2)))
      )
        continue;
      const file = path.join(root, 'skills', entry, 'SKILL.md');
      try {
        const { data } = matter(await fs.readFile(file, 'utf8'));
        const name = typeof data.name === 'string' ? data.name : entry;
        skills.push({
          kind: 'agent-skill',
          name,
          description: typeof data.description === 'string' ? data.description : undefined,
          source: 'skill',
          scope: 'user',
          path: file,
          enabled: true,
          claudeCommandName: `${index === 0 ? 'cindy' : `cindy-plugin-${id}`}:${name}`,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
    throw new Error('Skill owner changed during discovery');
  return skills;
};
