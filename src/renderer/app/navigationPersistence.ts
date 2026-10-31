export const LAST_ROUTE_KEY = 'asterium.navigation.lastRoute';
export const LAST_STUDIO_ROUTE_KEY = 'asterium.navigation.lastStudioRoute';
export const APP_ROUTE = /^\/(?:chat|profile|settings(?:\/partners)?|studio\/(?:discussion|workspace))$/;
const STUDIO_ROUTE = /^\/studio\/(?:discussion|workspace)$/;

export function readLastVisitedRoute() {
  const stored = window.localStorage.getItem(LAST_ROUTE_KEY) ?? '';
  return APP_ROUTE.test(stored) ? stored : '/chat';
}

export function rememberStudioRoute(pathname: string) {
  if (STUDIO_ROUTE.test(pathname)) window.localStorage.setItem(LAST_STUDIO_ROUTE_KEY, pathname);
}

export function readLastStudioRoute() {
  const stored = window.localStorage.getItem(LAST_STUDIO_ROUTE_KEY) ?? '';
  return STUDIO_ROUTE.test(stored) ? stored : '/studio/discussion';
}
