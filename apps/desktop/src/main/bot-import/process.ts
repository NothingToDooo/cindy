import { spawn } from 'node:child_process';
import { killProcessTree } from '../scheduler-host/proc-util.js';
import { CompanionImportError } from './types.js';

/** Imported commands get a private subprocess environment; the host environment is never mutated. */
export function runImportedProcess(input: {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number;
  signal: AbortSignal; assertOwner(): void;
}): Promise<{ stdout: string; exitCode: number }> {
  input.assertOwner();
  if (input.signal.aborted) return Promise.reject(new CompanionImportError('AUTOMATION_CANCELLED'));
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env,
      detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0; const chunks: Buffer[] = [];
    let failure: string | undefined; let settled = false;
    let forced: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timeout); clearInterval(ownerTimer); clearTimeout(forced); input.signal.removeEventListener('abort', abort); };
    const finish = (code: number | null) => {
      if (settled) return; settled = true; cleanup();
      if (failure) reject(new CompanionImportError(failure));
      else { try { input.assertOwner(); resolve({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode: code ?? 1 }); } catch { reject(new CompanionImportError('OWNER_CHANGED')); } }
    };
    const stop = (reason: string) => {
      if (failure || settled) return;
      failure = reason;
      killProcessTree(child.pid, child, () => { forced = setTimeout(() => finish(null), 2000); });
    };
    const abort = () => stop('AUTOMATION_CANCELLED');
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    const timeout = setTimeout(() => stop('AUTOMATION_TIMEOUT'), input.timeoutMs);
    const ownerTimer = setInterval(() => { try { input.assertOwner(); } catch { stop('OWNER_CHANGED'); } }, 250);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop('AUTOMATION_OUTPUT_TOO_LARGE'); else chunks.push(chunk); });
    // stderr can contain request headers, tokens and source URLs. Never send it to logs or models.
    child.stderr.resume();
    child.once('error', () => { failure = 'AUTOMATION_COMMAND_FAILED'; finish(null); });
    child.once('close', finish);
  });
}

export function redactEnvironmentValues(text: string, env: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(env)) if (value.length >= 8 && /TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(key)) result = result.split(value).join(`[${key}]`);
  return result;
}
