import path from 'node:path';
import { BETA_DATA_DIRECTORY } from '../../shared/appRelease';

export function betaUserDataDirectory(appData: string, explicitDirectory?: string) {
  return explicitDirectory ? path.resolve(explicitDirectory) : path.join(appData, BETA_DATA_DIRECTORY);
}
