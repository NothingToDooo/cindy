import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inspectImportSource, type SourceReaderDeps } from './sources.js';
import { fingerprint } from './files.js';
import { CompanionImportError, object, type ImportItem, type ImportSource } from './types.js';

const exec = promisify(execFile);

function definition(job: Record<string, unknown>): string {
  const { enabled: _enabled, state: _state, paused_at: _pausedAt, paused_reason: _pausedReason,
    next_run_at: _nextRun, last_run_at: _lastRun, last_status: _lastStatus, last_error: _lastError,
    last_delivery_error: _deliveryError, last_delivery_unverified: _deliveryUnverified,
    run_claim: _runClaim, runtime_updated_at_ms: _runtimeUpdated, failure_streak: _failureStreak, monitor_state: _monitorState, updatedAtMs: _updatedAt, ...rest } = job;
  if (rest.repeat) { const { completed: _completed, ...repeat } = object(rest.repeat); rest.repeat = repeat; }
  return fingerprint(rest);
}

async function binary(source: ImportSource, home: string): Promise<string> {
  const name = source.kind === 'hermes' ? 'hermes' : 'openclaw';
  const folders = [path.join(home, '.local', 'bin'), ...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of folders) {
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
      const file = path.join(dir, `${name}${suffix}`);
      try { if ((await fs.stat(file)).isFile()) return file; } catch { /* Continue the existing executable search path. */ }
    }
  }
  throw new CompanionImportError('SOURCE_COMMAND_UNAVAILABLE');
}

/** Native commands own the source lock/gateway. Never edit a live cron JSON or SQLite file. */
export async function changeSourceAutomationState(source: ImportSource, item: ImportItem, enabled: boolean,
  readers: SourceReaderDeps, assertOwner: () => void, resumeInterruptedPause = false): Promise<void> {
  const original = item.automation;
  if (!original || !/^[a-zA-Z0-9_-]{1,128}$/.test(original.sourceId)) throw new CompanionImportError('SOURCE_AUTOMATION_INVALID');
  const readCurrent = async () => {
    const snapshot = await inspectImportSource(source, readers); assertOwner();
    const current = snapshot.items.find(row => row.automation?.sourceId === original.sourceId);
    if (!current?.automation || definition(current.automation.original) !== definition(original.original)) throw new CompanionImportError('SOURCE_AUTOMATION_CHANGED');
    return current;
  };
  const before = await readCurrent();
  const running = (value: ImportItem) => !!value.automation?.original.run_claim || !!object(value.automation?.original.state).runningAtMs;
  if (!enabled && running(before)) throw new CompanionImportError(resumeInterruptedPause ? 'SOURCE_HANDOVER_PENDING' : 'SOURCE_AUTOMATION_RUNNING');
  if (before.view.enabled === enabled) {
    if (enabled || resumeInterruptedPause) return;
    throw new CompanionImportError('SOURCE_AUTOMATION_CHANGED');
  }
  const command = await binary(source, readers.home); assertOwner();
  const args = ['cron', source.kind === 'hermes' ? enabled ? 'resume' : 'pause' : enabled ? 'enable' : 'disable', original.sourceId];
  const env = { ...process.env, ...(source.kind === 'hermes' ? { HERMES_HOME: source.root } : { OPENCLAW_STATE_DIR: source.root, OPENCLAW_CONFIG_PATH: source.configFile }) };
  let commandFailed = false;
  try {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
      // Every argument except the trusted executable is fixed text or a validated portable ID.
      await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${command}" ${args.join(' ')}"`], { env, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
    } else await exec(command, args, { env, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch { commandFailed = true; }
  assertOwner();
  let after: ImportItem;
  try { after = await readCurrent(); } catch { throw new CompanionImportError('SOURCE_HANDOVER_UNCERTAIN'); }
  if (!enabled && after.view.enabled === false && running(after)) throw new CompanionImportError('SOURCE_HANDOVER_PENDING');
  if (commandFailed && after.view.enabled !== enabled) throw new CompanionImportError('SOURCE_HANDOVER_COMMAND_FAILED');
  if (after.view.enabled !== enabled) throw new CompanionImportError('SOURCE_HANDOVER_NOT_CONFIRMED');
}
