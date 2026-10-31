import { ArrowLeft, Check, Upload, UserRound, UsersRound } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePrototype } from '../app/PrototypeProvider';
import { sanitizePngDataUrl } from '../app/pngDataUrl';
import { ASTERIUM_LOGO_DATA_URL } from '../assets/asteriumLogoData';
import { AsteriumLogo } from '../components/ui/AsteriumLogo';
import { Avatar } from '../components/ui/Avatar';
import type { UserProfile } from '../types/domain';

export function ProfilePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, updateUserProfile, refreshProfiles } = usePrototype();
  const avatarInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<UserProfile>(state.userProfile);
  const [avatarError, setAvatarError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const baseline = useRef(state.userProfile);
  const isDirty = (value: UserProfile) => value.displayName !== baseline.current.displayName || value.introduction !== baseline.current.introduction || value.avatarDataUrl !== baseline.current.avatarDataUrl;

  const returnPath = (location.state as { from?: string } | null)?.from || '/chat';
  const avatarSrc = draft.avatarDataUrl || ASTERIUM_LOGO_DATA_URL;

  useEffect(() => window.asteriumAgents?.onPartnerProfilesChanged?.((profiles) => {
    setDraft((current) => {
      if (isDirty(current)) { if (profiles.user.revision !== current.revision) setSaveError('磁盘资料已变化，未保存的草稿已保留。可重新载入后编辑。'); return current; }
      const next: UserProfile = { ...current, ...profiles.user, audience: 'all' }; baseline.current = next; return next;
    });
  }), []);

  useEffect(() => {
    setDraft((current) => {
      if (isDirty(current)) return current;
      baseline.current = state.userProfile; return state.userProfile;
    });
  }, [state.userProfile]);

  const reload = async () => {
    try {
      const profiles = await refreshProfiles();
      if (profiles) { const next: UserProfile = { ...state.userProfile, ...profiles.user, audience: 'all' }; baseline.current = next; setDraft(next); setSaveError(''); setSaved(false); }
    } catch { setSaveError('未能读取磁盘资料，请重试。'); }
  };

  const handleAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setAvatarError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setAvatarError('请选择 PNG、JPG 或 WebP 图片。');
      event.target.value = '';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setAvatarError('图片请控制在 2 MB 以内。');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setDraft((current) => ({ ...current, avatarDataUrl: sanitizePngDataUrl(reader.result as string) }));
        setSaved(false);
      }
      event.target.value = '';
    };
    reader.readAsDataURL(file);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = draft.displayName.trim();
    if (!displayName) return;
    const profile: UserProfile = {
      ...draft,
      displayName,
      introduction: draft.introduction.trim(),
      audience: 'all',
      updatedAt: new Date().toISOString(),
    };
    setSaving(true); setSaveError('');
    try { const saved = await updateUserProfile(profile); baseline.current = saved; setDraft(saved); setSaved(true); }
    catch (error) { setSaveError(error instanceof Error && error.message.includes('PROFILE_VERSION_CONFLICT') ? '磁盘资料已变化，未覆盖外部修改；草稿已保留，请重新载入后编辑。' : '保存失败，草稿已保留，请重试。'); }
    finally { setSaving(false); }
  };

  return (
    <main className="settings-shell profile-shell">
      <aside className="glass-panel settings-nav">
        <div className="settings-brand"><AsteriumLogo /><div><strong>Asterium</strong><small>Personal Space</small></div></div>
        <button className="text-button back-button" type="button" onClick={() => navigate(returnPath)}><ArrowLeft size={17} />返回</button>
        <nav aria-label="个人设置">
          <button className="active" type="button"><UserRound size={18} /><span>个人资料</span><small>PROFILE</small></button>
        </nav>
        <p className="profile-nav-note">这份基础资料保存在星丛数据目录中；是否提供给本地与接回伙伴，可在各伙伴设置中单独选择。</p>
      </aside>

      <section className="glass-panel settings-main">
        <header className="settings-heading">
          <div><span><UserRound size={23} /></span><div><h1>个人资料</h1><p>新对话读取最新资料；已有单聊使用 /reload-user 更新，工作室需退出后重新加入。</p></div></div>
        </header>

        <form className="profile-form" onSubmit={submit}>
          <div className="profile-form-scroll">
            <section className="profile-hero">
              <input ref={avatarInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={handleAvatar} />
              <button className="profile-avatar-button" type="button" onClick={() => avatarInput.current?.click()} title="更换头像">
                <Avatar name={draft.displayName || '用户'} src={avatarSrc} accent="#91a9cf" size="lg" />
                <span><Upload size={15} />更换头像</span>
              </button>
              <div>
                <h2>{draft.displayName.trim() || '用户'}</h2>
                <p>默认使用星丛 Logo，也可以上传一张属于你的头像。</p>
                <div className="profile-avatar-actions">
                  <button className="secondary-button" type="button" onClick={() => avatarInput.current?.click()}>选择图片</button>
                  {draft.avatarDataUrl && <button className="text-button" type="button" onClick={() => { setDraft((current) => ({ ...current, avatarDataUrl: undefined })); setSaved(false); }}>恢复默认</button>}
                </div>
                {avatarError && <small className="form-error">{avatarError}</small>}
              </div>
            </section>

            <fieldset className="form-section">
              <legend>关于你</legend>
              <p>这部分会成为伙伴了解你的基础信息，你可以按自己的习惯慢慢补充。</p>
              <label>名字
                <input value={draft.displayName} maxLength={40} onChange={(event) => { setDraft((current) => ({ ...current, displayName: event.target.value })); setSaved(false); }} placeholder="你希望伙伴怎么称呼你" required />
              </label>
              <label>个人介绍
                <textarea value={draft.introduction} maxLength={4000} rows={10} onChange={(event) => { setDraft((current) => ({ ...current, introduction: event.target.value })); setSaved(false); }} placeholder="可以写性格、偏好、兴趣、生活习惯，以及希望伙伴怎样和你相处……" />
                <small className="profile-character-count">{draft.introduction.length} / 4000</small>
              </label>
            </fieldset>

            <fieldset className="form-section">
              <legend>共享范围</legend>
              <div className="profile-existing-note"><UsersRound size={17} /><span><strong>按伙伴单独授权</strong><small>API 伙伴默认使用；本地与接回伙伴默认关闭，可在伙伴设置中单独开启。资料写入「%APPDATA%\Asterium\AsteriumData\user\user-profile.md」。</small></span></div>
            </fieldset>
          </div>

          <footer className="form-footer profile-form-footer">
            <p>{saved ? <><Check size={15} />已保存；已有对话需显式重读</> : '修改仅保存在你的星丛本机'}</p>
            <div>{saveError && <span className="form-error">{saveError}</span>}<button className="secondary-button" type="button" disabled={saving} onClick={() => void reload()}>{draft.displayName !== state.userProfile.displayName || draft.introduction !== state.userProfile.introduction || draft.avatarDataUrl !== state.userProfile.avatarDataUrl ? '重新载入并放弃草稿' : '刷新资料'}</button><button className="secondary-button" type="button" onClick={() => navigate(returnPath)}>返回</button><button className="primary-button" type="submit" disabled={saving || !draft.displayName.trim()}>{saving ? '保存中…' : '保存资料'}</button></div>
          </footer>
        </form>
      </section>
    </main>
  );
}
