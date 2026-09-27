import { expect, it } from 'vitest';
import { mergeSessionEnvironment } from './session-environment.js';

it('gives subprocesses selected data credentials without contaminating another companion or model login', () => {
  const runtime = { HOME: '/managed/home', CODEX_HOME: '/managed/codex', DATA_TOKEN: 'host-fixture' };
  const imported = { HOME: '/source/home', CODEX_HOME: '/source/codex', OPENAI_API_KEY: 'source-fake-openai', ANTHROPIC_API_KEY: 'source-fake-anthropic', DATA_TOKEN: 'companion-fixture' };
  const a = mergeSessionEnvironment(runtime, imported);
  const b = mergeSessionEnvironment(runtime, { DATA_TOKEN: 'second-fixture' });
  expect(a).toEqual({ ...runtime, DATA_TOKEN: 'companion-fixture' });
  expect(b.DATA_TOKEN).toBe('second-fixture');
  expect(runtime.DATA_TOKEN).toBe('host-fixture');
  expect(imported.OPENAI_API_KEY).toBe('source-fake-openai'); // Preserved separately for explicit imported commands.
});
