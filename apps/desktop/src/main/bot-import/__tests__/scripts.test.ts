import { expect, it } from 'vitest';
import path from 'node:path';
import { importedScriptName } from '../scripts.js';

it('uses identical asset names on Windows for relative and absolute nested script paths', () => {
  expect(importedScriptName('C:\\agent', 'reports\\daily.py', path.win32)).toBe('scripts/reports/daily.py');
  expect(importedScriptName('C:\\agent', 'C:\\agent\\scripts\\reports\\daily.py', path.win32)).toBe('scripts/reports/daily.py');
  expect(() => importedScriptName('C:\\agent', '..\\outside.py', path.win32)).toThrow('AUTOMATION_SCRIPT_MISSING');
});
