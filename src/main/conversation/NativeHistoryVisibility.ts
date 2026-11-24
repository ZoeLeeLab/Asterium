import type { CodexHistoryTurn } from '../../shared/codexHistory';

/** Main-owned provenance, never supplied by a renderer history request. */
export interface NativeHistoryHiddenInputs {
  userMessageIds: ReadonlySet<string>;
  turnIds: ReadonlySet<string>;
}

export function visibleNativeHistoryTurns(turns: CodexHistoryTurn[], hidden?: NativeHistoryHiddenInputs): CodexHistoryTurn[] {
  if (!hidden || (!hidden.userMessageIds.size && !hidden.turnIds.size)) return turns;
  return turns.map(turn => {
    let firstUser = true;
    const items = turn.items.filter(item => {
      if (item.kind !== 'user') return true;
      const initialInput = firstUser;
      firstUser = false;
      return !hidden.userMessageIds.has(item.id) && !(initialInput && hidden.turnIds.has(turn.id));
    });
    // Keep replies, tools and later real user guidance in the original turn.
    return items.length === turn.items.length ? turn : { ...turn, items };
  });
}
