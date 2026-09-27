import { expect, it } from 'vitest';
import { importedProcessEnvironment } from '../process.js';
it.each(['darwin', 'win32'] as const)('inherits only OS basics and explicit imports on %s', platform => {
  const result = importedProcessEnvironment({ DATA_TOKEN: 'fixture-import-token', HTTPS_PROXY: 'fixture-selected-proxy', PATH: 'selected-bin' }, {
    [platform === 'win32' ? 'Path' : 'PATH']: 'host-bin', HOME: 'fixture-home', SystemRoot: 'fixture-system',
    GITHUB_TOKEN: 'fixture-host-token', HTTPS_PROXY: 'fixture-host-proxy', NODE_OPTIONS: '--require=private.js', PYTHONPATH: 'host-private-code',
  }, platform);
  expect(result).toMatchObject({ HOME: 'fixture-home', PATH: 'selected-bin', DATA_TOKEN: 'fixture-import-token', HTTPS_PROXY: 'fixture-selected-proxy' });
  expect(result).not.toHaveProperty('GITHUB_TOKEN');
  expect(result).not.toHaveProperty('NODE_OPTIONS');
  expect(result).not.toHaveProperty('PYTHONPATH');
  if (platform === 'win32') { expect(result.SYSTEMROOT).toBe('fixture-system'); expect(result).not.toHaveProperty('Path'); }
});
