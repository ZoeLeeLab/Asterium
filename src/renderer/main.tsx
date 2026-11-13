import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './app/App';
import { PrototypeProvider } from './app/PrototypeProvider';
import './styles/tokens.css';
import './styles/themes.css';
import './styles/globals.css';
import './styles/studio.css';
import './styles/settings.css';
import './styles/appearance.css';
import './styles/rainy-study.css';
import './styles/sea-letter.css';
import './styles/olympian-garden.css';
import './styles/alice-wonderland.css';
import './styles/scenic-materials.css';
import './styles/appearance-customization.css';
import './styles/automations.css';
import './styles/form-controls.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <PrototypeProvider>
        <App />
      </PrototypeProvider>
    </HashRouter>
  </StrictMode>,
);
