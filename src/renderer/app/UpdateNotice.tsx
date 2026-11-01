import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Modal } from '../components/ui/Modal';
import { useAppUpdates } from './useAppUpdates';

export function UpdateNotice() {
  const snapshot = useAppUpdates(), navigate = useNavigate();
  const location = useLocation();
  const [dismissed, setDismissed] = useState<string>();
  const version = snapshot.release?.version;
  if (snapshot.phase !== 'available' || !version || dismissed === version || (location.pathname.startsWith('/settings') && new URLSearchParams(location.search).get('section') === 'about')) return null;
  return <Modal title="星丛有新版本" description={`发现 ${version}，可在关于页查看说明并选择下载。`} onClose={() => setDismissed(version)}>
    <footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setDismissed(version)}>稍后再说</button><button className="primary-button" type="button" onClick={() => { setDismissed(version); navigate('/settings?section=about'); }}>查看更新</button></footer>
  </Modal>;
}
