import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as jsxRuntime from 'react/jsx-runtime';
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { getRemoteSessionPreviewCollapse, toRemoteSessionListItem } from '@cindy/maker-shared/session-list';
import { buildHomeProjectChildOffsets, resolveHomeProjectChildWindow, shouldWindowHomeProjectChildren } from '@/session/homeProjectChildWindow';

// Exercise the production child renderer without importing the entire native
// navigation stack. Anchor math is covered separately; native measurement needs
// an on-device scroll check.
const source = ts.createSourceFile('HomeSurface.tsx', readFileSync(resolve(process.cwd(), 'src/session/HomeSurface.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
  && node.name?.text === 'AutomationGroupChildren')!;
const compiled = ts.transpileModule(declaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function renderChildren(count: number, anchor: number, old = false) {
  const now = Date.now();
  const items = Array.from({ length: count }, (_, i) => toRemoteSessionListItem({
    id: `s${i}`, title: `Run ${i}`, status: 'active', agentKind: 'codex', model: 'model', workingDir: '/repo',
    createdAt: new Date(now - (old ? 30 * 86400000 : 1000)).toISOString(),
    updatedAt: new Date(now - (old ? 30 * 86400000 : 1000)).toISOString(),
  }, now));
  const onOpenSession = vi.fn();
  const dependencies = {
    exports: {},
    require: () => jsxRuntime,
    useThemedStyles: () => ({}), makeStyles: () => ({}), useTheme: () => ({ colors: {} }),
    useTranslation: () => ({ t: () => '' }), useRemoteHomeStatusVersion: () => 0,
    getRemoteSessionPreviewCollapse, PROJECT_PREVIEW_LIMIT: 5,
    remoteSessionStore: { isSessionRunning: () => false },
    useContext: () => ({ scrollY: { value: 0 }, viewportHeight: 800 }), HomeListViewportContext: {},
    useAnimatedRef: () => ({}), useSharedValue: (value: number) => ({ value }), useState: () => [anchor, () => {}],
    buildHomeProjectChildOffsets, estimateHomeSessionRowHeight: () => 60,
    shouldWindowHomeProjectChildren, resolveHomeProjectChildWindow,
    PROJECT_CHILD_WINDOW_THRESHOLD: 20, PROJECT_CHILD_WINDOW_OVERSCAN: 4, PROJECT_CHILD_WINDOW_SIZE: 15,
    Reanimated: { View: 'animated-view' }, View: 'view', HomeProjectWindowAnchorTracker: 'tracker',
    HomeSessionRow: 'row', SwipeableSessionRow: 'swipe', Fragment,
    Pressable: 'button', Text: 'text', ChevronRight: 'chevron', iconSize: {}, iconStroke: {},
  };
  const render = new Function(...Object.keys(dependencies), `${compiled}; return AutomationGroupChildren;`)(...Object.values(dependencies));
  const tree = render({ group: { key: 'group', items, sessionCount: count }, testID: 'fixture',
    onOpenSession, onOpenGroup: () => {}, inBlock: true, swipe: { registry: {}, onArchive: vi.fn() } });
  const elements: ReactElement<Record<string, any>>[] = [];
  function visit(node: ReactNode) {
    Children.forEach(node, child => {
      if (!isValidElement(child)) return;
      const element = child as ReactElement<Record<string, any>>;
      elements.push(element); visit(element.props.children);
    });
  }
  visit(tree);
  return { elements, onOpenSession };
}

it('bounds 200 recent runs before layout, while scrolling, and when reversing to the beginning', () => {
  for (const anchor of [-1, 0, 4, 96, 196, 96, 0]) {
    const { elements, onOpenSession } = renderChildren(200, anchor);
    const rows = elements.filter(node => node.type === 'row');
    expect(rows.length).toBeLessThanOrEqual(23);
    expect(rows.length).toBe(anchor < 0 ? 0 : anchor === 196 ? 15 : 23);
    const spacerHeight = elements.filter(node => node.type === 'view').reduce((sum, node) => sum + (node.props.style?.height ?? 0), 0);
    expect(spacerHeight + rows.length * 60).toBe(200 * 60);
    if (anchor < 0) continue;
    const first = rows[0];
    first.props.onOpenSession(first.props.item);
    expect(onOpenSession).toHaveBeenCalledWith(first.props.item);
    if (anchor === 0) expect(first.props.item.session.id).toBe('s0');
    if (anchor === 196) {
      expect(rows.at(-1)!.props.item.session.id).toBe('s199');
      expect(rows.at(-1)!.props.hideDivider).toBe(true);
    }
  }
});

it('preserves small previews and the view-all action for old runs', () => {
  expect(renderChildren(5, -1).elements.filter(node => node.type === 'row')).toHaveLength(5);
  const { elements } = renderChildren(200, -1, true);
  expect(elements.filter(node => node.type === 'row')).toHaveLength(5);
  expect(elements.filter(node => node.type === 'button')).toHaveLength(1);
});
