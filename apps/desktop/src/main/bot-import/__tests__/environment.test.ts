import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCompanionEnvironmentStore } from '../environment.js';
import { runImportedProcess } from '../process.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-environment-test-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('restores private variables from the credential store after restart and a real subprocess consumes them', async () => {
  const secrets = new Map<string, string>();
  const io = { read: (key: string) => secrets.get(key) ?? null, write: (key: string, value: string) => { secrets.set(key, value); return true; }, remove: (key: string) => { secrets.delete(key); return true; } };
  const store = createCompanionEnvironmentStore(io);
  await store.write(root, 'fixture', { version: 1, env: { DATA_TOKEN: 'fake-token-only-for-test' }, mcp: [], credentials: [] }, () => {});
  const manifest = await fs.readFile(path.join(root, 'bots/fixture/environment.json'), 'utf8');
  expect(manifest).not.toContain('fake-token-only-for-test');
  const restarted = createCompanionEnvironmentStore(io);
  const restored = await restarted.read(root, 'fixture', () => {});
  const output = await runImportedProcess({ command: process.execPath, args: ['-e', 'process.stdout.write(process.env.DATA_TOKEN === "fake-token-only-for-test" ? "authenticated" : "missing")'], cwd: root, env: restored!.env, timeoutMs: 5000, signal: new AbortController().signal, assertOwner() {} });
  expect(output).toEqual({ stdout: 'authenticated', exitCode: 0 });
  expect(process.env.DATA_TOKEN).not.toBe('fake-token-only-for-test');
  await expect(restarted.read(root, 'fixture', () => { throw new Error('account changed'); })).rejects.toThrow('account changed');
});
it('does not publish a usable manifest when secure storage rejects credentials', async () => {
  const store = createCompanionEnvironmentStore({ read: () => null, write: () => false, remove: () => true });
  await expect(store.write(root, 'fixture', { version: 1, env: { KEY: 'fake' }, mcp: [], credentials: [] }, () => {})).rejects.toThrow('CREDENTIAL_STORAGE_FAILED');
  await expect(fs.access(path.join(root, 'bots/fixture/environment.json'))).rejects.toThrow();
});
