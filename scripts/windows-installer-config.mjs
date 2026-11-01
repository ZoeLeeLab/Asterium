import path from 'node:path';
import { createHash } from 'node:crypto';

export function betaInstallerConfiguration({ projectRoot, outputDirectory, version, commit, electronVersion }) {
  if (!/^0\.1\.0-beta\.\d+$/.test(version)) throw new Error('BETA_VERSION_REQUIRED');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('EXISTING_BUILD_COMMIT_REQUIRED');
  const identity = createHash('sha256').update('Asterium.Beta.Windows.x64').digest('hex');
  const guid = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
  return {
    appId: 'Asterium.Beta', productName: 'Asterium Beta', electronVersion,
    directories: { output: outputDirectory, buildResources: path.join(projectRoot, 'assets') },
    publish: null, compression: 'normal',
    win: { executableName: 'Asterium', target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false, icon: path.join(projectRoot, 'assets/asterium.ico'), artifactName: `Asterium-${version}-win-x64-${commit.slice(0, 12)}-setup.\${ext}` },
    nsis: { guid, oneClick: false, perMachine: false, allowElevation: false, packElevateHelper: false, selectPerMachineByDefault: false, allowToChangeInstallationDirectory: true, runAfterFinish: false, deleteAppDataOnUninstall: false, createDesktopShortcut: false, createStartMenuShortcut: true, shortcutName: 'Asterium Beta', include: path.join(projectRoot, 'tools/installer/installer.nsh'), differentialPackage: false },
  };
}
