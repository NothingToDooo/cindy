import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');

describe('mobile Orca collaboration wiring', () => {
  it('lets the session + panel open the team panel for Leads and the enable form otherwise', () => {
    const source = read('app/sessions/[sessionId].tsx');
    expect(source).toContain('useSessionOrcaCollab({');
    expect(source).toContain("contextSheetView === 'collab' && collab.isLead ? (\n            <OrcaTeamPanelView");
    expect(source).toContain('testID="session.contextSheetCollabRow"');
    expect(source).toContain('onPress={() => void collab.submitEnable()}');
    expect(source).toContain('onPress={() => void collab.submitCreate()}');
  });

  it('keeps the Worker model picker separate from the task model', () => {
    const source = read('app/sessions/[sessionId].tsx');
    const start = source.indexOf('testID="session.collabModelSheet"');
    const block = source.slice(source.lastIndexOf('<ModelPickerSheet', start), start);
    expect(block).toContain('onSelect: collab.workerForm.modelPicker.select');
    expect(block).not.toContain('selectUnifiedComposerModel');
    expect(block).toContain('onClosed={collab.workerForm.modelPicker.closed}');
  });

  it('shows a collaboration bar for Leads and a way back to the Lead for Workers', () => {
    const source = read('app/sessions/[sessionId].tsx');
    expect(source).toContain('testID="session.collabBar"');
    expect(source).toContain('collab.openLead();');
    expect(source).toContain('takeOrcaStartFailure(sessionId)');
  });

  it('starts new-task collaboration after create with the pending Lead input as Worker context', () => {
    const source = read('app/sessions/new.tsx');
    expect(source).toContain('buildDraftWorkerInitialTask(collabDraft.initialTask, effectiveDraft.firstMessage)');
    expect(source).toContain('buildDraftWorkerInitialTask(collabDraft.initialTask, input.objective)');
    // 目标路径:协同在 goal.set 之前开启,首轮目标 Lead 才有协同工具。
    expect(source.indexOf('await enableOrcaTeam(maker, result.sessionId'))
      .toBeLessThan(source.indexOf('await maker.goal.set({ sessionId: result.sessionId'));
    expect(source).toContain('setCollabDraft(null);');
  });
});
