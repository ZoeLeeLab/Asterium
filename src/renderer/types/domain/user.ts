import type { AsteriumUserId } from '../../../shared/identity';

export type ThemeMode = 'light' | 'dark';

export type UserProfileAudience = 'local_cli' | 'api_partner' | 'all';

export interface UserProfile {
  id: AsteriumUserId;
  displayName: string;
  avatarDataUrl?: string;
  introduction: string;
  audience: UserProfileAudience;
  updatedAt: string;
  revision?: string;
}
