import type { CSSProperties } from 'react';
import { Code2, Laptop, UsersRound } from 'lucide-react';
import { DEFAULT_PARTNER_AVATAR_DATA_URL } from '../../assets/defaultPartnerAvatarData';
import type { Partner } from '../../types/domain';

interface AvatarProps {
  partnerId?: string;
  name: string;
  src?: string;
  accent?: string;
  size?: 'sm' | 'md' | 'lg';
  status?: boolean;
  source?: Partner['sourceMode'];
  selected?: boolean;
}

const sourceMeta = {
  existing_thread: { label: '现有伙伴', icon: UsersRound },
  local_cli: { label: '本地伙伴', icon: Laptop },
  api_partner: { label: 'API 伙伴', icon: Code2 },
} satisfies Record<Partner['sourceMode'], { label: string; icon: typeof UsersRound }>;

export function Avatar({ name, src, accent = '#69a7ff', size = 'md', status = false, source, selected = false, partnerId }: AvatarProps) {
  const style = { '--avatar-accent': accent } as CSSProperties;
  const sourceInfo = source ? sourceMeta[source] : undefined;
  const SourceIcon = sourceInfo?.icon;
  return (
    <span data-partner-id={partnerId} tabIndex={partnerId ? 0 : undefined} aria-haspopup={partnerId ? 'menu' : undefined} className={`avatar avatar--${size}${selected ? ' avatar--selected' : ''}${source ? ` avatar--source-${source.replace('_', '-')}` : ''}`} style={style} aria-label={`${name}的头像${sourceInfo ? `，${sourceInfo.label}` : ''}`}>
      {src ? <img src={src} alt="" /> : (
        <img className="avatar__fallback-image" src={DEFAULT_PARTNER_AVATAR_DATA_URL} alt="" />
      )}
      {sourceInfo && SourceIcon && <i className="avatar__source" data-source-label={sourceInfo.label} aria-hidden="true"><SourceIcon /></i>}
      {status && <i className="avatar__status" aria-label="在线" />}
    </span>
  );
}
