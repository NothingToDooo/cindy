import type { InteractionDecision } from '@cindy/maker-core';

/** One execution decision, with any number of channel/Desktop presentations. */
export interface SharedPermission {
  readonly result: Promise<InteractionDecision>;
  readonly decision: InteractionDecision | undefined;
  decide(decision: InteractionDecision): boolean;
}

export function createSharedPermission(): SharedPermission {
  let decision: InteractionDecision | undefined;
  let resolve!: (value: InteractionDecision) => void;
  const result = new Promise<InteractionDecision>((done) => {
    resolve = done;
  });
  return {
    result,
    get decision() {
      return decision;
    },
    decide(value) {
      if (decision || value.kind !== 'permission') return false;
      decision = value;
      resolve(value);
      return true;
    },
  };
}

export function isExpiredPermissionDecision(decision: InteractionDecision): boolean {
  return (
    decision.kind === 'permission' &&
    decision.behavior === 'deny' &&
    /timeout|session_disposed|session_aborted|session_closed|interaction_route_released|turn_terminal/.test(
      decision.reason ?? '',
    )
  );
}
