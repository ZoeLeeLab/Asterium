import { Plus, X } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import type { Partner } from '../../types/domain';

interface StudioMemberManagerProps {
  partners: Partner[];
  selectedIds: string[];
  onChange: (nextIds: string[]) => void;
  selectedTitle: string;
  addLabel: (partner: Partner) => string;
  removeLabel: (partner: Partner) => string;
  selectedDetail?: (partner: Partner) => string;
  emptySelection: string;
}

export function StudioMemberManager({
  partners,
  selectedIds,
  onChange,
  selectedTitle,
  addLabel,
  removeLabel,
  selectedDetail = (partner) => partner.publicIdentity.expertise || '团队成员',
  emptySelection,
}: StudioMemberManagerProps) {
  const available = partners.filter((partner) => !selectedIds.includes(partner.id));
  const selected = selectedIds
    .map((partnerId) => partners.find((partner) => partner.id === partnerId))
    .filter((partner): partner is Partner => Boolean(partner));

  return <div className="studio-member-manager">
    <section>
      <header><strong>可添加伙伴</strong><small>{available.length}</small></header>
      <div>
        {available.map((partner) => <button type="button" key={partner.id} aria-label={addLabel(partner)} onClick={() => onChange([...selectedIds, partner.id])}>
          <Avatar partnerId={partner.id} name={partner.publicIdentity.displayName} src={partner.publicIdentity.avatarDataUrl} accent={partner.accent} size="sm" />
          <span><strong>{partner.publicIdentity.displayName}</strong><small>{partner.publicIdentity.expertise || '尚未填写擅长'}</small></span>
          <Plus size={15} />
        </button>)}
        {!available.length && <p>所有可用伙伴都已在右侧</p>}
      </div>
    </section>
    <section className="selected">
      <header><strong>{selectedTitle}</strong><small>{selectedIds.length}</small></header>
      <div>
        {selected.map((partner) => <div className="studio-member-manager__selected" key={partner.id}>
          <Avatar partnerId={partner.id} name={partner.publicIdentity.displayName} src={partner.publicIdentity.avatarDataUrl} accent={partner.accent} size="sm" />
          <span><strong>{partner.publicIdentity.displayName}</strong><small>{selectedDetail(partner)}</small></span>
          <button type="button" onClick={() => onChange(selectedIds.filter((id) => id !== partner.id))} aria-label={removeLabel(partner)}><X size={14} /></button>
        </div>)}
        {!selectedIds.length && <p>{emptySelection}</p>}
      </div>
    </section>
  </div>;
}
