import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../src/renderer/data/initialState';
import { loadPrototypeState, savePrototypeState } from '../../src/renderer/app/persistence';
import { normalizeAsteriumUserAuthorId, ASTERIUM_USER_ID } from '../../src/shared/identity';

describe('release initial state', () => {
  it('starts and restarts without partners, conversations, projects or groups', () => {
    localStorage.clear();
    const initial = loadPrototypeState();
    expect(initial.userProfile.displayName).toBe('用户');
    expect([initial.partners, initial.conversations, initial.projects, initial.groupChats]).toEqual([[], [], [], []]);
    initial.userProfile.displayName = 'Custom user';
    savePrototypeState(initial);
    expect(loadPrototypeState().userProfile.displayName).toBe('Custom user');
    expect(loadPrototypeState().partners).toEqual([]);
  });
  it('keeps caller changes out of subsequent fresh states', () => {
    const first = createInitialState(); first.userProfile.displayName = 'Changed';
    expect(createInitialState().userProfile.displayName).toBe('用户');
  });
  it('normalizes declared users without treating display names as actor IDs', () => {
    expect(normalizeAsteriumUserAuthorId('mutable-name', 'user')).toBe(ASTERIUM_USER_ID);
    expect(normalizeAsteriumUserAuthorId('partner-id', 'partner')).toBe('partner-id');
    expect(normalizeAsteriumUserAuthorId('untyped-id')).toBe('untyped-id');
  });
});
