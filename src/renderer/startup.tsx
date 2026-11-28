import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { StartupWindowSnapshot } from '../shared/startupWindow';
import { StartupStatus } from './components/ui/StartupStatus';
import './styles/tokens.css';
import './styles/themes.css';

const mode = (() => { try { return localStorage.getItem('asterium.theme.v1'); } catch { return null; } })();
document.documentElement.dataset.theme = mode === 'light' || mode === 'dark'
  ? mode : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

// eslint-disable-next-line react-refresh/only-export-components -- This dedicated window entry owns its only root.
function StartupSplash() {
  const [state, setState] = useState<StartupWindowSnapshot>({ phase: 'loading', revision: 0 });
  useEffect(() => {
    const api = window.asteriumSplash;
    if (!api) return;
    let live = true;
    const receive = (next: StartupWindowSnapshot) => { if (live) setState(previous => next.revision >= previous.revision ? next : previous); };
    const unsubscribe = api.onState(receive);
    void api.get().then(receive).catch(() => { if (live) setState(previous => ({ phase: 'failed', revision: previous.revision })); });
    return () => { live = false; unsubscribe(); };
  }, []);
  return <StartupStatus failed={state.phase === 'failed'} onRetry={() => { void window.asteriumSplash?.retry().catch(() => undefined); }}
    onQuit={() => { void window.asteriumSplash?.quit().catch(() => undefined); }} />;
}

createRoot(document.getElementById('root')!).render(<StartupSplash />);
