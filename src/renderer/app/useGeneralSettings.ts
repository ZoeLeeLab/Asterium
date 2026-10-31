import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettingsSnapshot, type GeneralSettingsUpdate } from '../../shared/generalSettings';

export function useGeneralSettings() {
  const [snapshot, setSnapshot] = useState<GeneralSettingsSnapshot>({ revision: -1, settings: DEFAULT_GENERAL_SETTINGS, startupSupported: false });
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const apply = useCallback((value: GeneralSettingsSnapshot) => setSnapshot(current => value.revision >= current.revision ? value : current), []);
  const reload = useCallback(async () => {
    if (!window.asteriumGeneralSettings) { setLoading(false); return; }
    setLoading(true);
    try { apply(await window.asteriumGeneralSettings.get()); setError(''); }
    catch { setError('通用设置读取失败，请重试。'); }
    finally { setLoading(false); }
  }, [apply]);
  useEffect(() => {
    const unsubscribe = window.asteriumGeneralSettings?.onChanged(apply);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate desktop settings from the external Main store on mount.
    void reload();
    return unsubscribe;
  }, [apply, reload]);
  const update = useCallback(async (patch: GeneralSettingsUpdate) => {
    if (pending.current || !window.asteriumGeneralSettings) return;
    pending.current = true; setSaving(true); setError('');
    try { apply(await window.asteriumGeneralSettings.update(patch)); }
    catch {
      setError('设置未能保存，请重试或重新读取确认当前设置。');
      try { apply(await window.asteriumGeneralSettings.get()); } catch { /* Keep the last confirmed snapshot when storage is unavailable. */ }
    }
    finally { pending.current = false; setSaving(false); }
  }, [apply]);
  return { ...snapshot, loading, saving, error, update, reload, available: Boolean(window.asteriumGeneralSettings) && snapshot.revision >= 0 };
}
