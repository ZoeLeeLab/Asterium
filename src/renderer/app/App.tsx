import { useEffect, useState } from 'react';
import { DesktopNotificationNavigation } from './DesktopNotificationNavigation';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ChatPage } from '../pages/ChatPage';
import { ProfilePage } from '../pages/ProfilePage';
import { SettingsPage } from '../pages/SettingsPage';
import { StudioPage } from '../pages/StudioPage';
import { APP_ROUTE, LAST_ROUTE_KEY, readLastVisitedRoute, rememberStudioRoute } from './navigationPersistence';
import { PartnerAvatarMenu } from '../components/ui/PartnerAvatarMenu';
import { AutomationConfirmationHost } from '../components/settings/AutomationConfirmationDialog';

export function App() {
  const [initialRoute] = useState(readLastVisitedRoute);
  return (
    <div className="app-viewport">
      <div className="window-drag-strip" aria-hidden="true" />
      <LastVisitedRoute />
      <DesktopNotificationNavigation />
      <PartnerAvatarMenu />
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/diary" element={<Navigate to="/chat" replace />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/studio/:mode" element={<StudioPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/partners" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to={initialRoute} replace />} />
      </Routes>
      <AutomationConfirmationHost />
    </div>
  );
}

function LastVisitedRoute() {
  const location = useLocation();
  useEffect(() => {
    if (APP_ROUTE.test(location.pathname)) {
      window.localStorage.setItem(LAST_ROUTE_KEY, location.pathname);
      rememberStudioRoute(location.pathname);
    }
  }, [location.pathname]);
  return null;
}
