import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverImportSources, inspectImportSource } from '../sources.js';
import { validateImportSelection } from '../transfer.js';
import { selectedImportEnvironment } from '../environmentSelection.js';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-source-test-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
async function write(name: string, text: string) { const file = path.join(home, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
const deps = () => ({ home, env: {}, readCronDatabase: vi.fn(async () => []) });

describe('installed agent imports', () => {
  it('keeps secret references unexpanded until the final env and connection selection', async () => {
    await write('.hermes/config.yaml', 'name: Ada\nmcp_servers:\n  data:\n    url: https://example.invalid/mcp\n    headers:\n      Authorization: Bearer ${DATA_TOKEN}\n');
    await write('.hermes/.env', 'DATA_TOKEN=fake-selected-secret\nTELEGRAM_BOT_TOKEN=12345:fake-telegram-token');
    const reader = deps(); const [source] = await discoverImportSources(reader);
    const snapshot = await inspectImportSource(source!, reader);
    const mcp = snapshot.items.find(item => item.mcp)!;
    const token = snapshot.items.find(item => item.env?.DATA_TOKEN)!;
    expect(mcp.mcp?.headers?.Authorization).toBe('Bearer ${DATA_TOKEN}');
    expect(mcp.view.dependsOn).toContain(token.view.id);
    const telegram = snapshot.items.find(item => item.credential?.format === 'telegram')!;
    expect(telegram.credential?.value).toMatchObject({ token: '${TELEGRAM_BOT_TOKEN}' });
    expect(JSON.stringify(mcp)).not.toContain('fake-selected-secret');
    expect(JSON.stringify(telegram)).not.toContain('12345:fake-telegram-token');
  });
  it('preserves personality and memory, defaults to used skills and resolves environment without shell evaluation', async () => {
    await write('.hermes/config.yaml', 'name: Ada\n');
    await write('.hermes/SOUL.md', 'Calm, direct, and patient.');
    await write('.hermes/memories/USER.md', 'Prefers concise answers.');
    await write('.hermes/.env', 'DATA_API_KEY=not-a-real-secret-123\nDATA_URL=https://example.invalid/api\nLITERAL=$(never-run)');
    await write('.hermes/skills/report/SKILL.md', '---\nname: report\ndescription: Fetch DATA_URL using DATA_API_KEY\n---\nUse scripts/report.py');
    await write('.hermes/skills/report/scripts/report.py', 'print("fixture")');
    await write('.hermes/skills/unused/SKILL.md', '# unused');
    await write('.hermes/cron/jobs.json', JSON.stringify({ jobs: [{ id: 'daily', name: 'Report', prompt: 'Use report to read DATA_URL', skills: ['report'], schedule: { kind: 'interval', minutes: 5 }, enabled: true }] }));
    const reader = deps(); const sources = await discoverImportSources(reader);
    expect(sources).toHaveLength(1);
    const result = await inspectImportSource(sources[0]!, reader);
    expect(result.items.find(item => item.role === 'identity')?.text).toBe('Calm, direct, and patient.');
    expect(result.items.find(item => item.role === 'user')?.text).toContain('concise');
    expect(result.items.find(item => item.view.name === 'report')?.view.selected).toBe(true);
    expect(result.items.find(item => item.view.name === 'unused')?.view.selected).toBe(false);
    expect(result.items.find(item => item.env?.LITERAL)?.env?.LITERAL).toBe('$(never-run)');
    expect(JSON.stringify(result.items.map(item => item.view))).not.toContain('not-a-real-secret');
    const automation = result.items.find(item => item.automation)!;
    expect(automation.view.issues).toBeUndefined();
    expect(automation.automation?.input?.triggers).toEqual([{ id: 'time', kind: 'interval', intervalMs: 300000 }]);
    expect(automation.view.dependsOn).toContain(result.items.find(item => item.env?.DATA_API_KEY)!.view.id);
  });

  it('filters legacy OpenClaw tasks by selected agent and keeps paused tasks paused', async () => {
    await write('.openclaw/agents.json5', '{entries:[{id:"main",name:"Main",default:true},{id:"second",name:"Second"}]}');
    await write('.openclaw/openclaw.json', '{agents:{$include:"agents.json5"}}');
    await write('.openclaw/workspace-second/SOUL.md', 'Second persona');
    await write('.openclaw/cron/jobs.json', JSON.stringify({ jobs: [
      { id: 'a', agentId: 'main', name: 'Other', payload: { kind: 'agentTurn', message: 'Other reminder' }, schedule: { kind: 'every', everyMs: 60000 } },
      { id: 'b', agentId: 'second', name: 'Mine', enabled: false, payload: { kind: 'agentTurn', message: 'My reminder' }, schedule: { kind: 'every', everyMs: 120000, anchorMs: 100000 } },
    ] }));
    const reader = deps(); const sources = await discoverImportSources(reader);
    const source = sources.find(source => source.agentId === 'second')!;
    const snapshot = await inspectImportSource(source, reader);
    const tasks = snapshot.items.filter(item => item.automation);
    expect(tasks.map(item => item.view.name)).toEqual(['Mine']);
    expect(tasks[0]?.view.enabled).toBe(false);
    expect(tasks[0]?.automation?.input?.triggers[0]).toMatchObject({ kind: 'interval', anchorMs: 100000 });
  });

  it('uses the current SQLite source instead of stale JSON and never falls back on a DB failure', async () => {
    await write('.openclaw/openclaw.json', '{}');
    await write('.openclaw/state/openclaw.sqlite', 'fixture');
    await write('.openclaw/cron/jobs.json', '{"jobs":[]}');
    const reader = deps(); const [source] = await discoverImportSources(reader);
    reader.readCronDatabase.mockRejectedValue(new Error('unavailable'));
    await expect(inspectImportSource(source!, reader)).rejects.toThrow('unavailable');
    expect(reader.readCronDatabase).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main', defaultAgent: true }));
  });
});

it('imports Hermes context without turning unrelated repository instructions into personality', async () => {
  await write('.hermes/config.yaml', 'name: Ada\n');
  await write('.hermes/AGENTS.md', 'Only obey repository coding rules');
  await write('.hermes/CLAUDE.md', 'Project build instructions');
  const reader = deps(); const [source] = await discoverImportSources(reader);
  expect((await inspectImportSource(source!, reader)).items.filter(item => item.role === 'instructions')).toEqual([]);
  await write('.hermes/HERMES.md', 'Speak gently and briefly.');
  expect((await inspectImportSource(source!, reader)).items.find(item => item.role === 'instructions')?.text).toBe('Speak gently and briefly.');
});

it('selects nested automation scripts using the same portable asset identity as dependencies', async () => {
  await write('.hermes/config.yaml', 'name: Ada\n');
  await write('.hermes/scripts/reports/daily.sh', 'printf report');
  await write('.hermes/cron/jobs.json', JSON.stringify([{ id: 'daily', script: path.join('reports', 'daily.sh'), no_agent: true, schedule: { kind: 'interval', minutes: 5 } }]));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const script = snapshot.items.find(item => item.asset)!;
  expect(script.view.selected).toBe(true);
  expect(snapshot.items.find(item => item.automation)?.view.dependsOn).toContain(script.view.id);
});

it.each(['daily-report', 'Daily report'])('matches a skill reference %s against both its directory and display name', async reference => {
  await write('.hermes/config.yaml', 'name: Ada\n');
  await write('.hermes/.env', 'REPORT_TOKEN=fixture-token\nREPORT_URL=https://example.invalid/api');
  await write('.hermes/skills/daily-report/SKILL.md', '---\nname: Daily report\n---\nUse scripts/query.py');
  await write('.hermes/skills/daily-report/scripts/query.py', 'print(os.environ["REPORT_TOKEN"], os.environ["REPORT_URL"])');
  await write('.hermes/cron/jobs.json', JSON.stringify([{ id: 'daily', prompt: 'Read my report', skills: [reference], schedule: { kind: 'interval', minutes: 5 } }]));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const skill = snapshot.items.find(item => item.view.category === 'skills')!;
  const automation = snapshot.items.find(item => item.automation)!;
  expect(skill.view.selected).toBe(true);
  expect(automation.view.dependsOn).toEqual(expect.arrayContaining([
    skill.view.id, ...snapshot.items.filter(item => item.env).map(item => item.view.id),
  ]));
  expect(skill.files?.find(file => file.name === 'scripts/query.py')).toBeDefined();
});


it('requires an explicit credential account and binds variables to the chosen profile, including MCP references', async () => {
  await write('.openclaw/openclaw.json', JSON.stringify({ mcpServers: { data: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${OPENAI_API_KEY}' } } } }));
  await write('.openclaw/agents/main/agent/auth-profiles.json', JSON.stringify({ profiles: {
    'openai:work': { provider: 'openai', type: 'api_key', key: 'fixture-work-key' },
    'openai:personal': { provider: 'openai', type: 'api_key', key: 'fixture-personal-key' },
  } }));
  await write('.openclaw/cron/jobs.json', JSON.stringify({ jobs: [{ id: 'report', agentId: 'main', payload: { message: 'Use data with OPENAI_API_KEY' }, schedule: { kind: 'every', everyMs: 60000 } }] }));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const profiles = snapshot.items.filter(item => item.env?.OPENAI_API_KEY);
  expect(profiles).toHaveLength(2);
  expect(profiles.every(item => !item.view.selected)).toBe(true);
  expect(profiles[0]!.view.exclusiveWith).toEqual([profiles[1]!.view.id]);
  const defaults = snapshot.items.filter(item => item.view.selected).map(item => item.view.id);
  const selection = { requestId: 'fixture-credential-request', previewId: 'preview', name: 'Ada', takeover: true, entryIds: defaults };
  expect(() => validateImportSelection({ ...selection, entryIds: [...defaults, ...profiles.map(item => item.view.id)] }, snapshot)).toThrow('INVALID_SELECTION');
  for (const profile of profiles) {
    const selected = validateImportSelection({ ...selection, entryIds: [...defaults, profile.view.id] }, snapshot);
    expect(selectedImportEnvironment(selected).OPENAI_API_KEY).toBe(profile.env!.OPENAI_API_KEY);
    for (const consumer of selected.filter(item => item.mcp || item.automation)) {
      expect(consumer.view.dependsOn).toContain(profile.view.id);
      expect(consumer.view.dependsOn?.every(id => selected.some(item => item.view.id === id))).toBe(true);
      expect(consumer.view.issues).toBeUndefined();
    }
  }
  const missing = validateImportSelection(selection, snapshot).find(item => item.automation)!;
  expect(missing.view.dependsOn?.some(id => !defaults.includes(id))).toBe(true);
  expect(JSON.stringify(snapshot.items.map(item => item.view))).not.toContain('fixture-work-key');
  expect(JSON.stringify(snapshot.items.map(item => item.view))).not.toContain('fixture-personal-key');
});
