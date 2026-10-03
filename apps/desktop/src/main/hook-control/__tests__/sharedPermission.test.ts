import { describe, expect, it, vi } from 'vitest';
import { createSharedPermission } from '../../maker-ipc/sharedPermission';
import {
  composeInteractionCard,
  registerHookInteraction,
  resolveHookInteraction,
} from '../interactions';

describe('hook permission mirrors', () => {
  it.each(['desktop', 'hook'])(
    'settles from %s, retains origin and rejects the other surface',
    async (surface) => {
      const permission = createSharedPermission();
      const id = `shared-${surface}`;
      const composed = composeInteractionCard({
        kind: 'permission',
        requestId: id,
        toolName: 'Read',
        input: {},
        description: '来源：开发群\n原消息：检查仓库',
      })!;
      const onFallback = vi.fn();
      const pending = registerHookInteraction({
        interactionId: id,
        composed,
        onFallback,
        sharedPermission: permission,
      });
      if (surface === 'desktop')
        expect(permission.decide({ kind: 'permission', behavior: 'allow' })).toBe(true);
      else expect(resolveHookInteraction(id, 'perm:allow')).toBe(true);
      expect(resolveHookInteraction(id, 'perm:deny')).toBe(false);
      await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
      expect(onFallback).toHaveBeenCalledWith(expect.stringContaining('来源：开发群'));
      expect(onFallback).toHaveBeenCalledWith(expect.stringContaining('已允许'));
    },
  );
});
