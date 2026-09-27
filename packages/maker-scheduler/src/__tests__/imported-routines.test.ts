import { expect, it, vi } from 'vitest';
import { RoutineEngine, type RoutineState } from '../routine-engine.js';
import { nextRoutineTriggerAt } from '../routines.js';

it('keeps interval phase instead of restarting its clock during import', () => {
  expect(nextRoutineTriggerAt({ id: 'tick', kind: 'interval', intervalMs: 60000, anchorMs: 10000 }, 65000)).toBe(70000);
});
it('fires an imported one-shot only once, including after restoring its durable state', async () => {
  let now = 1000; let seq = 0; let state: RoutineState | null = null;
  const execute = vi.fn(async () => ({ resultText: 'reminder' }));
  const deps = { load: async () => structuredClone(state), save: async (value: RoutineState) => { state = structuredClone(value); }, execute, id: () => `id-${++seq}`, now: () => now, changed() {}, onError(error: unknown) { throw error; } };
  const engine = new RoutineEngine(deps); await engine.start();
  await engine.put('bot', { name: 'Reminder', prompt: 'Remember', enabled: true, triggers: [{ id: 'at', kind: 'once', at: 2000 }] });
  now = 2000; await engine.tick(); await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1)); await engine.stop();
  const restarted = new RoutineEngine(deps); await restarted.start(); now = 500000; await restarted.tick(); await restarted.stop();
  expect(execute).toHaveBeenCalledTimes(1);
});
