import { parseRoutineInput, type RoutineTrigger } from '@cindy/maker-scheduler';
import { fingerprint } from './files.js';
import { object, string, type ImportItem, type ImportSource } from './types.js';
import path from 'node:path';
import { importDelivery } from './delivery.js';

/** Runtime counters are not configuration; changes to them must not invalidate a handover. */
export function automationFingerprint(job: Record<string, unknown>): string {
  return fingerprint(Object.fromEntries(Object.entries(job).filter(([key]) =>
    !['state', 'last_run_at', 'last_status', 'last_error', 'last_delivery_error', 'last_delivery_unverified', 'failure_streak', 'next_run_at', 'monitor_state', 'updatedAtMs'].includes(key))));
}

export function normalizeAutomation(source: ImportSource, job: Record<string, unknown>, items: ImportItem[], timezone: string): ImportItem {
  const sourceId = string(job.id) || string(job.jobId);
  const schedule = object(job.schedule);
  const payload = object(job.payload);
  const name = string(job.name) || sourceId;
  const enabled = job.enabled !== false && job.state !== 'paused';
  const prompt = source.kind === 'hermes' ? string(job.prompt) : string(payload.message) || string(payload.text);
  const issues: string[] = [];
  let trigger: RoutineTrigger | undefined;
  if (schedule.kind === 'cron') {
    trigger = { id: 'time', kind: 'cron', expression: string(schedule.expr), timezone: string(schedule.tz) || string(schedule.timezone) || timezone };
  } else if (schedule.kind === 'interval' || schedule.kind === 'every') {
    trigger = { id: 'time', kind: 'interval', intervalMs: schedule.kind === 'every' ? Number(schedule.everyMs) : Number(schedule.minutes) * 60_000,
      ...(Number.isSafeInteger(schedule.anchorMs) ? { anchorMs: Number(schedule.anchorMs) } : {}) };
  } else if (schedule.kind === 'once' || schedule.kind === 'at') {
    trigger = { id: 'time', kind: 'once', at: Date.parse(string(schedule.at) || string(schedule.run_at)) };
  } else issues.push('AUTOMATION_TRIGGER_NEEDS_ADAPTER');

  const selectedSkills = new Set([string(job.skill), ...(Array.isArray(job.skills) ? job.skills.map(string) : [])]);
  const scriptNames = [string(job.script), string(job.monitor_script)].filter(Boolean).map(file => `scripts/${path.relative(path.join(source.root, 'scripts'), path.resolve(source.root, 'scripts', file)).split(path.sep).join('/')}`);
  const scriptItems = items.filter(item => item.asset && scriptNames.includes(item.asset.name));
  const searchText = [prompt, ...scriptItems.map(item => item.asset!.bytes.toString('utf8')), ...items.filter(item => item.view.category === 'skills' && selectedSkills.has(item.view.name)).flatMap(item => (item.files ?? []).filter(file => /\.(md|py|js|mjs|sh|ts|json|yaml|yml|toml)$/i.test(file.name)).map(file => file.bytes.toString('utf8')))].join('\n');
  const dependsOn = items.filter(item =>
    item.view.category === 'skills' && selectedSkills.has(item.view.name) ||
    item.env && Object.keys(item.env).some(key => new RegExp(`\\b${key}\\b`).test(searchText)) ||
    item.mcp && searchText.includes(item.mcp.name) || item.asset && scriptNames.includes(item.asset.name)).map(item => item.view.id);
  const delivery = importDelivery(source, job, items);
  dependsOn.push(...delivery.deliveries.map(item => item.connectionId));
  issues.push(...delivery.issues);
  if (scriptItems.length !== new Set(scriptNames).size) issues.push('AUTOMATION_SCRIPT_MISSING');
  if (job.no_agent === true && !job.script) issues.push('AUTOMATION_SCRIPT_MISSING');
  // These source-specific semantics are retained verbatim and require an explicit adapter.
  // Never start a simpler task while claiming it inherited a stricter tool policy/model/context.
  if (job.enabled_toolsets || Object.keys(object(job.tools)).length || items.some(item => item.credential?.format === 'source-tools')) issues.push('SOURCE_TOOL_POLICY_NEEDS_MAPPING');
  if (job.context_from) issues.push('AUTOMATION_CONTEXT_NEEDS_MAPPING');
  if (job.model || job.provider || job.base_url || payload.model || job.reasoning_effort || payload.thinking) issues.push('AUTOMATION_MODEL_NEEDS_MAPPING');
  if (job.workdir && path.resolve(string(job.workdir)) !== path.resolve(source.workspace)) issues.push('AUTOMATION_WORKDIR_NEEDS_MAPPING');
  if (job.failure_deliver && job.failure_deliver !== job.deliver) issues.push('DELIVERY_NEEDS_ADAPTER');
  if (!sourceId || !name) issues.push('SOURCE_AUTOMATION_INVALID');
  // These are explicit source features, not guessed equivalent prompt instructions.
  if (Number(schedule.staggerMs) > 0) issues.push('AUTOMATION_STAGGER_NEEDS_ADAPTER');
  let input;
  if (trigger) {
    try { input = parseRoutineInput({ name, prompt: prompt || string(job.script) || [...selectedSkills].filter(Boolean).join('\n'), enabled: false, triggers: [trigger], silentWhenIdle: false }); }
    catch { issues.push('SOURCE_AUTOMATION_INVALID'); }
  }
  return {
    view: { id: `automation-${fingerprint(sourceId).slice(0, 20)}`, category: 'automations', name, enabled, selected: true,
      description: string(job.schedule_display) || string(schedule.expr) || (trigger?.kind === 'once' && Number.isFinite(trigger.at) ? new Date(trigger.at).toISOString() : ''),
      dependsOn, ...(issues.length ? { issues } : {}) },
    automation: { sourceId, input, original: job, deliveries: delivery.deliveries, fingerprint: automationFingerprint(job) },
  };
}
