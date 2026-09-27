import { and, eq, isNull, ne } from 'drizzle-orm';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { botSessionLinks, botProfiles, sessions } from '../localDb/schema.js';
import { botEnvironmentSecretIo } from '../secrets/providerSecretStore.js';
import { createCompanionEnvironmentStore } from './environment.js';
import { fingerprint } from './files.js';
import { CompanionImportError } from './types.js';

export const companionEnvironmentStore = createCompanionEnvironmentStore({
  read: key => botEnvironmentSecretIo.read(key),
  write: (key, value) => botEnvironmentSecretIo.write(key, value),
  remove: key => botEnvironmentSecretIo.remove(key),
});

/** Resolve from the main-owned session link, never from a renderer-supplied Bot ID or path. */
export async function readCompanionSessionEnvironment(sessionId: string) {
  const owner = activeOwnerScopeKey();
  const userData = ownerScopedUserDataPath();
  const assertOwner = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner)
      throw new CompanionImportError('OWNER_CHANGED');
  };
  assertOwner();
  const [link] = await getDbClient().drizzle.select({ botId: botSessionLinks.botId })
    .from(botSessionLinks).innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId)).innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId)).where(and(eq(botSessionLinks.sessionId, sessionId), isNull(botSessionLinks.archivedAt), eq(botProfiles.status, 'active'), eq(sessions.status, 'active'), ne(botSessionLinks.role, 'history'))).limit(1);
  assertOwner();
  if (!link) return undefined;
  const environment = await companionEnvironmentStore.read(userData, link.botId, assertOwner);
  if (!environment) return undefined;
  return { identity: fingerprint([owner, link.botId, environment.env, environment.mcp, environment.credentials]), environment, assertOwner, botId: link.botId, userData };
}

export async function resolveCompanionRuntimeEnvironment(sessionId: string) {
  const result = await readCompanionSessionEnvironment(sessionId);
  return result ? { identity: result.identity, assertCurrent: result.assertOwner } : undefined;
}
