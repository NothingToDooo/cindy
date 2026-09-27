import { expect, it, vi } from 'vitest';
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'fixture-owner', isAppSessionBoundaryPending: () => false, ownerScopedUserDataPath: () => '/fixture' }));
vi.mock('../../secrets/providerSecretStore.js', () => ({ botEnvironmentSecretIo: {} }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => {
  const query = { from: () => query, innerJoin: () => query, where: () => query, limit: async () => [{ botId: 'fixture-bot' }] };
  return { drizzle: { select: () => query } };
} }));
import { companionEnvironmentStore, resolveCompanionRuntimeEnvironment } from '../runtime.js';

it('projects only opaque identity and owner fencing into all harnesses, never imported values', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 'fixture-token', GITHUB_PAT: 'fixture-pat', DATABASE_URL: 'postgres://fixture:secret@example.invalid/db',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: fixture-header', ANTHROPIC_UNIX_SOCKET: '/fixture/socket', UNUSUAL_NAME: 'short' };
  vi.spyOn(companionEnvironmentStore, 'read').mockResolvedValue({ version: 1, env, mcp: [], credentials: [] });
  const result = await resolveCompanionRuntimeEnvironment('fixture-session');
  expect(result).toEqual({ identity: expect.any(String), assertCurrent: expect.any(Function) });
  for (const value of Object.values(env)) expect(JSON.stringify(result)).not.toContain(value);
  result!.assertCurrent();
});
