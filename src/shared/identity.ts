/** Stable local user identity. Display names are mutable and must never be used as actor IDs. */
export const ASTERIUM_USER_ID = 'asterium:user:local' as const;

export type AsteriumUserId = typeof ASTERIUM_USER_ID;

export function normalizeAsteriumUserId(): AsteriumUserId {
  return ASTERIUM_USER_ID;
}

export function normalizeAsteriumUserAuthorId(authorId: string, authorType?: 'user' | 'partner' | 'system') {
  if (authorType === 'partner' || authorType === 'system') return authorId;
  return authorType === 'user' ? ASTERIUM_USER_ID : authorId;
}

export function isAsteriumUser(authorId: string) {
  return authorId === ASTERIUM_USER_ID;
}
